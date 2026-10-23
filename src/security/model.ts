import { ConfigurationError } from "../errors.js";

export function assertModelDoesNotExposeCredential(model: string, apiKey: string): void {
  if (apiKey.length > 0 && model.includes(apiKey)) {
    throw new ConfigurationError(
      "The requested model id contains the stored API key. Refusing before evidence, configuration, or network changes.",
    );
  }
}
