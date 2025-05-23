<script lang="ts">
  import { API } from "$lib/api";
  import { deployContract, switchToNetwork } from "$lib/ethereum";
  import type { ApprovalProcess, CreateApprovalProcessRequest } from "$lib/models/approval-process";
  import type { ABIParameter, Artifact, DeployContractRequest, DeploymentResult, UpdateDeploymentRequest } from "$lib/models/deploy";
  import { getNetworkLiteral, isProductionNetwork } from "$lib/models/network";
  import { buildCompilerInput, type ContractSources } from "$lib/models/solc";
  import type { APIResponse, HTMLInputElementEvent } from "$lib/models/ui";
  import { addNewApprovalProcessAndSelectExisting, findDeploymentEnvironment, globalState, setConstructorArgumentValues, setDeploymentCompleted, setDeterministicSalt, setRequiredConstructorArguments } from "$lib/state/state.svelte";
  import { attempt } from "$lib/utils/attempt";
  import { encodeConstructorArgs, getConstructorInputsWizard, getContractBytecode } from "$lib/utils/contracts";
  import { debouncer, isMultisig, isUpgradeable } from "$lib/utils/helpers";
  import Button from "./shared/Button.svelte";
  import Input from "./shared/Input.svelte";
  import Message from "./shared/Message.svelte";
  import fileSaver from "file-saver";
  import { version as solcVersion } from "$lib/generated/solcVersion.json";

  // debounce the compile call to avoid sending too many requests while the user is editing.
  const compileDebounced = debouncer(compile, 600);

  let isDeploying = $state(false);
  let successMessage = $state<string>("");
  let errorMessage = $state<string>("");
  let compilationError = $state<string>("");
  let compilationResult = $state<{ output: Artifact['output'] }>();
  let deploymentId = $state<string | undefined>(undefined);
  let deploymentResult = $state<DeploymentResult | undefined>(undefined);
  let isCompiling = $state(false);

  const hasSetUpBlockExplorerKeyForCurrentNetwork = $derived.by(() => globalState.blockExplorerKeys.some((key) => key.network === globalState.form.network?.name));

  let deterministic = $derived.by(() => globalState.form.deterministic);

  // Set callback for clearing deployment status messages
  globalState.clearDeploymentStatus = () => {
    setDeploymentCompleted(false);
    successMessage = "";
    errorMessage = "";
  };

  let contractBytecode = $derived.by(() => {
    if (!globalState.contract?.target || !compilationResult) return;

    const name = globalState.contract.target;
    const sources = compilationResult.output.contracts;

    return getContractBytecode(name, name, sources);
  });

  let deploymentArtifact = $derived.by(() => {
    if (!compilationResult || !globalState.contract?.target || !globalState.contract.source?.sources) return;
   
    return {
      input: buildCompilerInput(globalState.contract.source?.sources as ContractSources),
      output: compilationResult.output
    }
  });

  let displayUpgradeableWarning = $derived.by(() => {
    return isUpgradeable(globalState.contract?.source?.sources as ContractSources);
  });

  $effect(() => {
    const selectedMultisig = globalState.form.approvalType === 'existing' && isMultisig(globalState.form.approvalProcessSelected?.viaType);
    const toCreateMultisig = globalState.form.approvalType === 'new' && isMultisig(globalState.form.approvalProcessToCreate?.viaType);
    const hasReasonMessage = globalState.contract?.enforceDeterministicReason !== undefined;
    globalState.form.deterministic.isEnforced = selectedMultisig || toCreateMultisig || hasReasonMessage;
  });

  const deploymentEnvironmentUrl: string | undefined = $derived(
    globalState.form.network ? `https://defender.openzeppelin.com/#/deploy/environment/${
      isProductionNetwork(globalState.form.network) ? 'production' : 'test'
    }`
    : undefined
  );

  const deploymentEnvironmentUrlWithFallback: string = $derived(
    deploymentEnvironmentUrl ?? 'https://defender.openzeppelin.com/#/deploy'
  );

  const deploymentUrl: string | undefined = $derived(
    deploymentId && deploymentEnvironmentUrl
      ? `${deploymentEnvironmentUrl}?deploymentId=${deploymentId}`
    : undefined
  );

  let inputs: ABIParameter[] = $state([]);

  $effect(() => {
    if (globalState.contract?.source?.sources) {
      isCompiling = true;
      setDeploymentCompleted(false);
      compileDebounced();
    }
  });

  function handleInputChange(event: HTMLInputElementEvent) {
    const {name, value} = event.currentTarget;
    setConstructorArgumentValues(name, value);
  }

  async function compile(): Promise<void> {
    const sources = globalState.contract?.source?.sources;
    if (!sources) {
      return;
    }

    const [res, error] = await attempt(async () => API.compile(buildCompilerInput(
      globalState.contract!.source!.sources as ContractSources
    )));

    if (error) {
      compilationError = `Compilation failed: ${error.msg}`;
      return;
    }
    compilationResult = res.data;

    if (globalState.contract?.target && compilationResult) {
      inputs = getConstructorInputsWizard(globalState.contract.target, compilationResult.output.contracts);

      setRequiredConstructorArguments(inputs.map((input) => input.name));

      // Clear deploy status messages
      successMessage = "";
      errorMessage = "";
    }
    isCompiling = false;
  }

  function displayMessage(message: string, type: "success" | "error") {
    successMessage = "";
    errorMessage = "";
    if (type === "success") {
      successMessage = message;
    } else {
      errorMessage = message;
    }
  }

  function handleSaltChanged(event: HTMLInputElementEvent) {
    const saltValue = event.currentTarget.value;
    setDeterministicSalt(saltValue);
  }

  export async function handleInjectedProviderDeployment(bytecode: string) {
    // Switch network if needed
    const [, networkError] = await attempt(async () => switchToNetwork(globalState.form.network!));
    if (networkError) {
      throw new Error(`Error switching network: ${networkError.msg}`);
    }

    const [result, error] = await attempt(async () => deployContract(bytecode));
    if (error) {
      throw new Error(`Error deploying contract: ${error.msg}`);
    }

    if (!result) {
      throw new Error("Deployment result not found");
    }

    displayMessage(`Contract deployed successfully, hash: ${result?.hash}`, "success");
    
    return {
      address: result.address,
      hash: result.hash,
      sender: result.sender
    };
  }


  async function getOrCreateApprovalProcess(): Promise<ApprovalProcess | undefined> {
    const ap = globalState.form.approvalProcessToCreate;
    if (!ap || !ap.via || !ap.viaType) {
      displayMessage("Must select an approval process to create", "error");
      return;
    }

    if (!globalState.form.network) {
      displayMessage("Must select a network", "error");
      return;
    }

    const existing = findDeploymentEnvironment(ap.via, ap.network);
    if (existing) {
      return existing;
    }

    const apRequest: CreateApprovalProcessRequest = {
      name: `Deploy From Wizard - ${ap.viaType}`,
      via: ap.via,
      viaType: ap.viaType,
      network: getNetworkLiteral(globalState.form.network),
      relayerId: ap.relayerId,
      component: ["deploy"],
    };
    const result: APIResponse<{ approvalProcess: ApprovalProcess }> =
      await API.createApprovalProcess(apRequest);

    if (!result.success) {
      displayMessage(`Approval process creation failed, error: ${JSON.stringify(result.error)}`, "error");
      return;
    }

    displayMessage("Deployment Environment successfully created", "success");
    if (!result.data) return;

    addNewApprovalProcessAndSelectExisting(result.data.approvalProcess)

    return result.data.approvalProcess;
  }

  export async function createDefenderDeployment(request: DeployContractRequest) {
    const result: APIResponse<{ deployment: { deploymentId: string } }> =
      await API.createDeployment(request);

    if (!result.success || !result.data) {
      throw new Error(`Contract deployment creation failed: ${JSON.stringify(result.error)}`);
    }

    return result.data.deployment.deploymentId;
  }

  export async function updateDeploymentStatus(
    deploymentId: string,
    address: string,
    hash: string
  ) {
    const updateRequest: UpdateDeploymentRequest = {
      deploymentId,
      hash,
      address,
    };
    
    const result = await API.updateDeployment(updateRequest);
    if (!result.success) {
      throw new Error(`Failed to update deployment status: ${JSON.stringify(result.error)}`);
    }
  }

  async function deploy() {
    if (!globalState.form.network) {
      displayMessage("No network selected", "error");
      return;
    }

    if (!globalState.contract?.target || !globalState.contract.source?.sources) {
      displayMessage("No contract selected", "error");
      return;
    }

    if (!deploymentArtifact || !contractBytecode) {
      displayMessage("No artifact found", "error");
      return;
    }

    if ((deterministic.isSelected || deterministic.isEnforced) && !deterministic.salt) {
      if (globalState.contract?.enforceDeterministicReason) {
        displayMessage(`Salt is required: ${globalState.contract.enforceDeterministicReason}`, "error");
      } else {
        displayMessage("Salt is required", "error");
      }
      return;
    }

    errorMessage = "";
    successMessage = "";

    const [constructorBytecode, constructorError] = await encodeConstructorArgs(inputs, globalState.form.constructorArguments.values);
    if (constructorError) {
      displayMessage(`Error encoding constructor arguments: ${constructorError.msg}`, "error");
      return;
    }

    // contract deployment requires contract bytecode
    // and constructor bytecode to be concatenated.
    const bytecode = contractBytecode + constructorBytecode?.slice(2);

    const shouldUseInjectedProvider = globalState.form.approvalType === "injected";
    if (shouldUseInjectedProvider) {
      const [result, error] = await attempt(async () =>
        handleInjectedProviderDeployment(bytecode),
      );
      if (error) {
        displayMessage(`Error deploying contract: ${error.msg}`, "error");
        return;
      }

      deploymentResult = result;

      // loads global state with EOA approval process to create
      globalState.form.approvalProcessToCreate = {
        viaType: "EOA",
        via: deploymentResult?.sender,
        network: getNetworkLiteral(globalState.form.network),
      };
      globalState.form.approvalProcessSelected = undefined;
    }

    const approvalProcess = globalState.form.approvalProcessSelected ?? await getOrCreateApprovalProcess();
    if (!approvalProcess) {
      displayMessage("No Approval Process selected", "error");
      return;
    };

    const deployRequest: DeployContractRequest = {
      network: getNetworkLiteral(globalState.form.network),
      approvalProcessId: approvalProcess.approvalProcessId,
      contractName: globalState.contract.target,
      contractPath:  globalState.contract.target,
      verifySourceCode: true,
      licenseType: 'MIT',
      artifactPayload: JSON.stringify(deploymentArtifact),
      constructorBytecode,
      salt: deterministic.isSelected || deterministic.isEnforced ? deterministic.salt : undefined,
      origin: 'Wizard',
    }

    const [newDeploymentId, deployError] = await attempt(async () => createDefenderDeployment(deployRequest));
    if (deployError || !newDeploymentId) {
      displayMessage(`Deployment failed to create: ${deployError?.msg}`, "error");
      return;
    }

    if (shouldUseInjectedProvider && deploymentResult) {
      const [, updateError] = await attempt(async () => updateDeploymentStatus(
        newDeploymentId,
        deploymentResult!.address,
        deploymentResult!.hash
      ));
      if (updateError) {
        displayMessage(`Error updating deployment status: ${updateError.msg}`, "error");
        return;
      }
    } else {
      // If we're not using an injected provider
      // we need to listen for the deployment to be finished.
      // listenForDeployment(newDeploymentId);
    }

    deploymentId = newDeploymentId;
    displayMessage("Deployment successfuly created in Defender", "success");
  };

  async function triggerDeploy() {
    isDeploying = true;
    setDeploymentCompleted(false);
    await deploy();
    setDeploymentCompleted(successMessage.length > 0 && errorMessage.length === 0);
    isDeploying = false;
  }

  const downloadSolcInputHandler = async () => {
    if (deploymentArtifact !== undefined && globalState?.contract?.target !== undefined) {
      const blob = new Blob([JSON.stringify(deploymentArtifact?.input, null, 2)], { type: 'text/plain' });
      fileSaver.saveAs(blob, `${globalState.contract.target}-solc-input.json`);
    }
  };
</script>

<div class="flex flex-col gap-2">
  {#if displayUpgradeableWarning}
    <Message type="warn" message="Upgradable contracts are not yet fully supported. This action will only deploy the implementation contract without initializing. <br />We recommend using <u><a href='https://github.com/OpenZeppelin/openzeppelin-upgrades' target='_blank'>openzeppelin-upgrades</a></u> package instead." />
  {/if}

  {#if isCompiling}
    <Message type="loading" message="Compiling..." />
  {:else if inputs.length > 0}
    <h6 class="text-sm">Constructor Arguments</h6>
    {#each inputs as input}
      <Input name={input.name} title={`${input.name} (${input.type})`} placeholder={`${input.name} (${input.type})`} onchange={handleInputChange} value={String(globalState.form.constructorArguments.values[input.name] || "")} type="text"/>
    {/each}
  {:else}
    <Message type="info" message="No constructor arguments found" />
  {/if}

  <div class="pt-2 flex">
    <input 
    type="checkbox"
    id="isDeterministic" 
    checked={deterministic.isSelected || deterministic.isEnforced}
    onchange={() => (globalState.form.deterministic.isSelected = !deterministic.isSelected)}
    disabled={deterministic.isEnforced}
  >
    <label class="text-sm left-4 pl-2" for="isDeterministic">
      Deterministic
    </label>
  </div>

  {#if deterministic.isSelected || deterministic.isEnforced}
    <Input
      name="salt"
      type="text"
      title="Salt"
      placeholder="Salt"
      value={deterministic.salt || ""}
      onchange={handleSaltChanged}
    />
  {/if}

  {#if compilationError}
    <Message message={compilationError} type="error" />
  {/if}

  <Button disabled={!globalState.authenticated || isDeploying || isCompiling} loading={isDeploying} label="Deploy" onClick={triggerDeploy} />

  {#if successMessage || errorMessage} 
    <Message message={successMessage || errorMessage} type={successMessage ? "success" : "error"} />

    {#if deploymentUrl}
      <Button label={"View Deployment"} onClick={() => window.open(deploymentUrl, "_blank")} type="secondary" />
    {/if}
  {/if}

  {#if !isCompiling}
  <div class="alert alert-success d-flex align-items-center mt-2">
    <div class="flex flex-row items-center gap-2">
      <i class={`fa fa-lightbulb-o text-lime-600`}></i>
      <div class="text-xs text-gray-600">
        {#if !hasSetUpBlockExplorerKeyForCurrentNetwork}
          <p>Ensure you have an Explorer API Key set in your <u><a href='{deploymentEnvironmentUrlWithFallback}' target='_blank'>Deploy Environment</a></u> for the current network to allow the contract to be verified automatically.</p>
        {:else}
          <p>The contract will be verified automatically on the block explorer for this network.</p>
        {/if}
        <p class="mt-2">Or you can download the <button type="button" onclick={downloadSolcInputHandler}><u>Solidity standard input JSON</u></button> for this contract to verify it manually on block explorers, using Solidity compiler version <code>{solcVersion}</code>.</p>
      </div>
    </div>
  </div>
  {/if}
</div>