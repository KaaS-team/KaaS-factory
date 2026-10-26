// Where a secret is read by name. Callers hold the name, never the value in config or argv, so a
// vault adapter can replace the environment without any caller changing.

export interface SecretsPort {
  // undefined when the secret is not set; an empty value counts as not set.
  get(name: string): string | undefined;
}
