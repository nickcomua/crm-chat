import type { Infer } from "spacetimedb";
import type {
  LoginToken,
  PasswordToken,
  SignInSuccess,
} from "../../lib/spacetime";

// Result types for the authentication flow callbacks

export type SendLoginCodeResult =
  | { status: "success"; loginToken: Infer<typeof LoginToken> }
  | { status: "already_authorized" }
  | { status: "failed"; error: string };

export type ReceiveLoginCodeResult =
  | { status: "success"; code: string }
  | { status: "aborted" };

export type VerifyLoginCodeResult =
  | { status: "success"; signIn: Infer<typeof SignInSuccess> }
  | { status: "password_required"; passwordToken: Infer<typeof PasswordToken> }
  | { status: "invalid_code" }
  | { status: "signup_required" }
  | { status: "failed"; error: string };

export type ReceivePasswordResult =
  | { status: "success"; password: string }
  | { status: "aborted" };

export type VerifyPasswordResult =
  | { status: "success"; signIn: Infer<typeof SignInSuccess> }
  | { status: "invalid_password" }
  | { status: "failed"; error: string };

export type GenerateQrCodeResult =
  | { status: "token"; url: string; expires: number }
  | { status: "authorized"; signIn: Infer<typeof SignInSuccess> }
  | { status: "already_authorized"; signIn: Infer<typeof SignInSuccess> }
  | { status: "failed"; error: string };
