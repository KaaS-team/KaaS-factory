// SecretsPort on the process environment. A name must look like an env var, so a caller cannot
// be tricked into reading something that is not a secret slot.
import type { SecretsPort } from "../../ports/secrets";

const NAME = /^[A-Z][A-Z0-9_]*$/;

export class EnvSecrets implements SecretsPort {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  get(name: string): string | undefined {
    if (!NAME.test(name)) throw new Error(`not a secret name: ${name}`);
    const value = this.env[name];
    return value ? value : undefined;
  }
}
