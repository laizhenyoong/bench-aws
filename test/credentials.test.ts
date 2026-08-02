import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getReadOnlyCredentials,
  credentialEnv,
  withCredentials,
  assertReadOnly,
  type ReadOnlyCredentials,
} from "../src/credentials.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(child_process.execFileSync);

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

function federationResponse(expiration = FUTURE) {
  return JSON.stringify({
    Credentials: {
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: expiration,
    },
    FederatedUser: {
      FederatedUserId: "123456789012:benchaws",
      Arn: "arn:aws:sts::123456789012:federated-user/benchaws",
    },
  });
}

/** Build an error shaped like the one execFileSync throws on a non-zero exit. */
function execError(stderr: string): Error {
  const err = new Error("Command failed") as Error & { stderr: string; stdout: string };
  err.stderr = stderr;
  err.stdout = "";
  return err;
}

beforeEach(() => {
  mockedExecFileSync.mockReset();
});

describe("getReadOnlyCredentials", () => {
  it("requests a federation token scoped by the ReadOnlyAccess policy", () => {
    mockedExecFileSync.mockReturnValue(federationResponse() as never);

    const creds = getReadOnlyCredentials({ force: true });

    expect(creds.accessKeyId).toBe("ASIAEXAMPLE");
    expect(creds.arn).toContain("federated-user/benchaws");

    const [bin, args] = mockedExecFileSync.mock.calls[0] as [string, string[]];
    expect(bin).toBe("aws");
    expect(args).toContain("get-federation-token");
    expect(args).toContain("arn=arn:aws:iam::aws:policy/ReadOnlyAccess");
  });

  it("reuses a cached session instead of minting a new one each call", () => {
    mockedExecFileSync.mockReturnValue(federationResponse() as never);

    getReadOnlyCredentials({ force: true });
    const callsAfterFirst = mockedExecFileSync.mock.calls.length;
    getReadOnlyCredentials();
    getReadOnlyCredentials();

    expect(mockedExecFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-mints when the cached session is close to expiry", () => {
    // Expires in 60s, inside the 5-minute refresh margin.
    mockedExecFileSync.mockReturnValue(
      federationResponse(new Date(Date.now() + 60_000).toISOString()) as never,
    );
    getReadOnlyCredentials({ force: true });
    const callsAfterFirst = mockedExecFileSync.mock.calls.length;

    getReadOnlyCredentials();
    expect(mockedExecFileSync.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});

describe("credentialEnv", () => {
  const creds: ReadOnlyCredentials = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiresAt: Date.now() + 3600_000,
    arn: "arn:aws:sts::123456789012:federated-user/benchaws",
  };

  it("exports the full key trio plus region", () => {
    const env = credentialEnv(creds, "ap-southeast-1");
    expect(env.AWS_ACCESS_KEY_ID).toBe("ASIAEXAMPLE");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    expect(env.AWS_SESSION_TOKEN).toBe("token");
    expect(env.AWS_REGION).toBe("ap-southeast-1");
    expect(env.AWS_DEFAULT_REGION).toBe("ap-southeast-1");
  });

  it("does not set a profile variable of its own", () => {
    expect(credentialEnv(creds, "ap-southeast-1")).not.toHaveProperty("AWS_PROFILE");
  });
});

describe("withCredentials", () => {
  const creds: ReadOnlyCredentials = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiresAt: Date.now() + 3600_000,
    arn: "arn:aws:sts::123456789012:federated-user/benchaws",
  };

  it("deletes inherited profile variables rather than blanking them", () => {
    const env = withCredentials(
      { AWS_PROFILE: "prod", AWS_DEFAULT_PROFILE: "prod", HOME: "/home/x" },
      creds,
      "ap-southeast-1",
    );

    expect("AWS_PROFILE" in env).toBe(false);
    expect("AWS_DEFAULT_PROFILE" in env).toBe(false);
    expect(env.AWS_ACCESS_KEY_ID).toBe("ASIAEXAMPLE");
    expect(env.HOME).toBe("/home/x");
  });

  it("applies extra overrides on top", () => {
    const env = withCredentials({}, creds, "us-east-1", { PATH: "/opt/homebrew/bin" });
    expect(env.PATH).toBe("/opt/homebrew/bin");
    expect(env.AWS_REGION).toBe("us-east-1");
  });
});

describe("assertReadOnly", () => {
  const creds: ReadOnlyCredentials = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiresAt: Date.now() + 3600_000,
    arn: "arn:aws:sts::123456789012:federated-user/benchaws",
  };

  it("passes when reads succeed and the mutation is denied", () => {
    mockedExecFileSync
      .mockReturnValueOnce('{"Arn":"arn:aws:sts::123456789012:federated-user/benchaws"}' as never)
      .mockImplementationOnce(() => {
        throw execError(
          "An error occurred (UnauthorizedOperation) when calling the CreateKeyPair operation",
        );
      });

    expect(() => assertReadOnly(creds, "ap-southeast-1")).not.toThrow();
  });

  it("throws when the session is authorized to mutate", () => {
    // DryRunOperation means the call would have succeeded — the session has write access.
    mockedExecFileSync
      .mockReturnValueOnce('{"Arn":"..."}' as never)
      .mockImplementationOnce(() => {
        throw execError("An error occurred (DryRunOperation) when calling the CreateKeyPair operation");
      });

    expect(() => assertReadOnly(creds, "ap-southeast-1")).toThrow(/NOT read-only|authorized for ec2:CreateKeyPair/);
  });

  it("throws when the mutation unexpectedly succeeds outright", () => {
    mockedExecFileSync
      .mockReturnValueOnce('{"Arn":"..."}' as never)
      .mockReturnValueOnce("{}" as never);

    expect(() => assertReadOnly(creds, "ap-southeast-1")).toThrow(/NOT read-only/);
  });

  it("throws when the basic read call fails", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw execError("ExpiredToken");
    });

    expect(() => assertReadOnly(creds, "ap-southeast-1")).toThrow(
      /cannot make a basic read call/,
    );
  });

  it("throws when the denial reason is unrecognised rather than assuming safety", () => {
    mockedExecFileSync
      .mockReturnValueOnce('{"Arn":"..."}' as never)
      .mockImplementationOnce(() => {
        throw execError("Could not connect to the endpoint URL");
      });

    expect(() => assertReadOnly(creds, "ap-southeast-1")).toThrow(/inconclusive/);
  });
});
