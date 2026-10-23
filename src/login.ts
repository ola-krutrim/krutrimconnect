import { password, rawlist } from "@inquirer/prompts";

import {
  KRUTRIM_SIGN_IN_URL,
  openKrutrimSignInPage,
} from "./browser.js";

export type KrutrimLoginChoice = "create" | "existing";

export const KRUTRIM_LOGIN_CHOICES = [
  {
    name: "Create one for me — opens your browser to sign in or sign up",
    value: "create",
  },
  {
    name: "I already have a key — paste it securely",
    value: "existing",
  },
] as const;

export interface InteractiveLoginDependencies {
  choose(): Promise<KrutrimLoginChoice>;
  readKey(): Promise<string>;
  openSignIn(): Promise<void>;
  write(message: string): void;
}

function defaultDependencies(): InteractiveLoginDependencies {
  return {
    choose: async () => await rawlist({
      message: "Choose how to continue:",
      choices: KRUTRIM_LOGIN_CHOICES,
      loop: false,
    }),
    readKey: async () => await password({
      message: "Krutrim model API key:",
      mask: "*",
    }),
    openSignIn: async () => await openKrutrimSignInPage(),
    write: (message) => process.stderr.write(message),
  };
}

export async function promptForKrutrimApiKey(
  overrides: Partial<InteractiveLoginDependencies> = {},
): Promise<string> {
  const dependencies: InteractiveLoginDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  dependencies.write(
    "\nKrutrimConnect needs a Krutrim API key for this machine.\n" +
      "(Removable anytime with krutrimconnect logout.)\n\n",
  );
  const choice = await dependencies.choose();
  if (choice === "create") {
    dependencies.write(`\nOpening ${KRUTRIM_SIGN_IN_URL}...\n`);
    try {
      await dependencies.openSignIn();
      dependencies.write("Browser opened. Sign in or sign up to continue.\n");
    } catch {
      dependencies.write(
        `Could not open a browser automatically. Open ${KRUTRIM_SIGN_IN_URL} manually.\n`,
      );
    }
    dependencies.write(
      "Create a Krutrim model API key, then return here and paste it securely.\n\n",
    );
  }
  return await dependencies.readKey();
}
