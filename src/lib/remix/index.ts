// place files you want to import through the `$lib` alias in this folder.
import { PluginClient } from "@remixproject/plugin";
import { createClient } from "@remixproject/plugin-iframe";
import { listenOnThemeChanged } from "./theme";
import { listenOnCompilerResults } from "./compiler";
import type { CustomApi } from "@remixproject/plugin-utils";
import type { ITerminal } from "@remixproject/plugin-api/src/lib/terminal";

export let terminal: CustomApi<ITerminal> | null= null;

export const initPlugin = () => {
  const plugin = new PluginClient({ allowOrigins: ['https://remix.ethereum.org'] });
  const client = createClient(plugin);

  // when users select a new theme, the plugin adopts new styles.
  listenOnThemeChanged(client);

  // when users compile a contract, the plugin gets the results.
  listenOnCompilerResults(client);

  terminal = client.terminal;
}