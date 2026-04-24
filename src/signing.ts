// Local EOA signing flow. Fetches the canonical signingHash from the backend,
// validates its shape before handing it to viem, signs, and POSTs back.
// Retries once on a stale signer nonce.

import { privateKeyToAccount } from "viem/accounts";

import { loadLocalKeyPublic, loadLocalPrivateKey } from "./config.js";
import { httpRequest, SplitsApiError } from "./http.js";

type SigningEnv = {
  SPLITS_API_KEY?: string;
  SPLITS_API_URL?: string;
};

export type SignResponse = {
  data: {
    id: string;
    status: string;
    signerId: string;
    submitted: boolean;
    userOpHash: string | null;
    submissionError: string | null;
  };
};

type TxGetResponse = { data: { signingHash?: string | null } };

// Exact 32-byte keccak output: "0x" + 64 hex chars. Validating shape before
// passing to viem blocks a malformed API response from coercing the CLI into
// signing attacker-chosen bytes as raw message input.
const SIGNING_HASH_RE = /^0x[0-9a-f]{64}$/i;

const fetchSigningHash = async (
  env: SigningEnv,
  txId: string,
): Promise<`0x${string}`> => {
  const tx = await httpRequest<TxGetResponse>(env, `/transactions/${txId}`, {
    requireAuth: true,
  });
  const hash = tx.data.signingHash;
  if (hash === null || hash === undefined) {
    throw new SplitsApiError(
      "transaction-not-cli-signable",
      0,
      "This transaction does not expose a signingHash (e.g. merkle or deploy paths). Sign via the web app.",
    );
  }
  if (typeof hash !== "string" || !SIGNING_HASH_RE.test(hash)) {
    throw new SplitsApiError(
      "invalid-signing-hash",
      0,
      `Backend returned a malformed signingHash (${JSON.stringify(hash)}). Refusing to sign.`,
    );
  }
  return hash as `0x${string}`;
};

export const signHash = (
  privateKey: `0x${string}`,
  hash: `0x${string}`,
): Promise<`0x${string}`> =>
  privateKeyToAccount(privateKey).signMessage({ message: { raw: hash } });

export async function signTransactionLocally(
  env: SigningEnv,
  txId: string,
  opts: { submit: boolean },
): Promise<SignResponse> {
  const privateKey = await loadLocalPrivateKey();
  const publicInfo = await loadLocalKeyPublic();
  if (privateKey === null || publicInfo === null) {
    throw new SplitsApiError(
      "no-local-key",
      0,
      "No local signing key. Run `splits auth create-key` or `splits auth import-key` first.",
    );
  }

  const account = privateKeyToAccount(privateKey);

  const postSignature = async (
    signingHash: `0x${string}`,
  ): Promise<SignResponse> => {
    const signature = await signHash(privateKey, signingHash);
    return httpRequest<SignResponse>(env, `/transactions/${txId}/sign`, {
      method: "POST",
      requireAuth: true,
      body: {
        eoaSigner: account.address,
        signature,
        submit: opts.submit,
      },
    });
  };

  const signingHash = await fetchSigningHash(env, txId);
  try {
    return await postSignature(signingHash);
  } catch (err) {
    // Nonce-stale races happen under active multisig use; retry once with a
    // fresh GET + re-sign. A second failure is surfaced verbatim.
    if (
      err instanceof SplitsApiError &&
      err.splitsCode === "INVALID_SIGNER_NONCE"
    ) {
      const freshHash = await fetchSigningHash(env, txId);
      return await postSignature(freshHash);
    }
    // Annotate signer-auth errors with the local address so users can see
    // which key the CLI tried to sign with; caller still gets a code to
    // branch on.
    if (err instanceof SplitsApiError && err.splitsCode === "INVALID_SIGNER") {
      throw new SplitsApiError(
        "signer-not-authorized",
        err.status,
        `Local key ${account.address} is not an authorized signer on this transaction. ` +
          `If you just registered this key via update-signers, the registration proposal ` +
          `must be approved and executed before it can sign other transactions.`,
      );
    }
    throw err;
  }
}
