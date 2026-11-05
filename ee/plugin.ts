// SPDX-License-Identifier: LicenseRef-KaaS-EE
// The plugin entry: the loader calls this default export once when "enterprise" is enabled in the
// machine config's plugins.enabled.
import { registerEe } from "./enterprise";

export default (env: NodeJS.ProcessEnv = process.env): void => registerEe(env);
