/**
 * Read-only credential minting.
 *
 * The agent runs unsandboxed, so "read-only" is enforced by minting a short-lived
 * STS federation token scoped to ReadOnlyAccess and injecting it into every
 * condition — a mutation fails at the IAM layer regardless of what runs.
 *
 * Known limitation: federation-token sessions can't call IAM/STS at all (they
 * fail with InvalidClientTokenId, not AccessDenied), so tasks avoid IAM.
 */

import { execFileSync } from "node:child_process";

const READ_ONLY_POLICY_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";
const SESSION_NAME = "benchaws";
const SESSION_DURATION_SECONDS = 3600;
/** Key name used only by the dry-run write probe; never actually created. */
const MUTATION_PROBE_KEY_NAME = "bench-aws-readonly-probe";
/** Re-mint when this much of the session or less remains. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ReadOnlyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch millis at which the session stops working. */
  expiresAt: number;
  /** ARN of the federated user, for logging and preflight assertions. */
  arn: string;
}

interface FederationTokenResponse {
  Credentials: {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken: string;
    Expiration: string;
  };
  FederatedUser: { Arn: string };
}

let cached: ReadOnlyCredentials | undefined;

/**
 * Mint (or reuse) a ReadOnlyAccess-scoped federation token.
 *
 * The call itself uses the caller's normal credential chain — the default
 * profile, an env-var key pair, whatever `aws` would already use.
 */
export function getReadOnlyCredentials(
  opts: { force?: boolean; region?: string } = {},
): ReadOnlyCredentials {
  if (!opts.force && cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cached;
  }

  const raw = execFileSync(
    "aws",
    [
      "sts",
      "get-federation-token",
      "--name",
      SESSION_NAME,
      "--duration-seconds",
      String(SESSION_DURATION_SECONDS),
      "--policy-arns",
      `arn=${READ_ONLY_POLICY_ARN}`,
      "--output",
      "json",
    ],
    {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...(opts.region ? { AWS_REGION: opts.region } : {}) },
    },
  );

  const parsed = JSON.parse(raw) as FederationTokenResponse;
  cached = {
    accessKeyId: parsed.Credentials.AccessKeyId,
    secretAccessKey: parsed.Credentials.SecretAccessKey,
    sessionToken: parsed.Credentials.SessionToken,
    expiresAt: Date.parse(parsed.Credentials.Expiration),
    arn: parsed.FederatedUser.Arn,
  };
  return cached;
}

/** Environment overrides that point any AWS SDK or CLI at the read-only session. */
export function credentialEnv(
  creds: ReadOnlyCredentials,
  region: string,
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
}

/**
 * Build a child-process environment carrying the read-only session.
 *
 * AWS_PROFILE is deleted, not blanked: a set profile outranks the key trio and
 * would hand the agent full-access credentials; an empty one just breaks the CLI.
 */
export function withCredentials(
  base: NodeJS.ProcessEnv,
  creds: ReadOnlyCredentials,
  region: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...credentialEnv(creds, region), ...extra };
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  return env;
}

/**
 * Confirm the minted session can read but not write.
 *
 * `ec2 create-key-pair --dry-run` needs no pre-existing resource: a write-capable
 * session reports DryRunOperation, a read-only one reports UnauthorizedOperation,
 * and no key pair is created either way.
 */
export function assertReadOnly(creds: ReadOnlyCredentials, region: string): void {
  const env = withCredentials(process.env, creds, region);

  try {
    execFileSync("aws", ["sts", "get-caller-identity", "--output", "json"], {
      encoding: "utf-8",
      timeout: 30_000,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `Read-only session cannot make a basic read call: ${describeExecError(err)}`,
    );
  }

  let stderr = "";
  let mutationSucceeded = false;
  try {
    execFileSync(
      "aws",
      [
        "ec2",
        "create-key-pair",
        "--key-name",
        MUTATION_PROBE_KEY_NAME,
        "--dry-run",
      ],
      { encoding: "utf-8", timeout: 30_000, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    mutationSucceeded = true;
  } catch (err) {
    stderr = describeExecError(err);
  }

  if (mutationSucceeded) {
    throw new Error(
      "ec2:CreateKeyPair --dry-run exited zero — the session is NOT read-only. " +
        "Refusing to run the benchmark with write-capable credentials.",
    );
  }

  if (stderr.includes("DryRunOperation")) {
    throw new Error(
      "Read-only check failed: the session is authorized for ec2:CreateKeyPair. " +
        "Refusing to run the benchmark with write-capable credentials.",
    );
  }
  if (!stderr.includes("UnauthorizedOperation")) {
    throw new Error(
      `Read-only check was inconclusive. Expected UnauthorizedOperation, got: ${stderr.slice(0, 400)}`,
    );
  }
}

function describeExecError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return e.stderr || e.stdout || e.message || String(err);
}
