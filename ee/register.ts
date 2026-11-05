// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Turns the org features on: `bun --preload ./ee/register.ts bin/factory ...`. Each one registers
// only when its settings are present, so preloading this changes nothing until it is configured.
import { registerEe } from "./enterprise";

export { ORG_MODE_ENV, registerEe, SPEND_POLICY_ENV } from "./enterprise";

registerEe();
