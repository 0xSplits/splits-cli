// Local EOA signing flow. Fetches the canonical signingHash from the backend,
// validates its shape before handing it to viem, signs, and POSTs back.
// Retries once on a stale signer nonce.

import { privateKeyToAccount } from "viem/accounts";

import { loadLocalKey } from "./config.js";
import { type Credentials, httpRequest, SplitsApiError } from "./http.js";

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

const assertSigningHash = ({
  hash,
  missingCode,
  missingMessage,
}: {
  hash: unknown;
  missingCode: string;
  missingMessage: string;
}): `0x${string}` => {
  if (hash === null || hash === undefined) {
    throw new SplitsApiError(missingCode, 0, missingMessage);
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

const fetchSigningHash = async (
  env: Credentials,
  txId: string,
): Promise<`0x${string}`> => {
  const tx = await httpRequest<TxGetResponse>(env, `/transactions/${txId}`, {
    requireAuth: true,
  });
  return assertSigningHash({
    hash: tx.data.signingHash,
    missingCode: "transaction-not-cli-signable",
    missingMessage:
      "This transaction does not expose a signingHash (e.g. merkle or deploy paths). Sign via the web app.",
  });
};

const requireLocalKey = async (keyAddress?: string) => {
  const localKey = await loadLocalKey(keyAddress);
  if (localKey === null) {
    throw new SplitsApiError(
      "no-local-key",
      0,
      "No local signing key. Run `splits auth create-key` or `splits auth import-key` first.",
    );
  }
  return localKey;
};

export const signHash = (
  privateKey: `0x${string}`,
  hash: `0x${string}`,
): Promise<`0x${string}`> =>
  privateKeyToAccount(privateKey).signMessage({ message: { raw: hash } });

export async function signTransactionLocally(
  env: Credentials,
  txId: string,
  opts: { submit: boolean; keyAddress?: string },
): Promise<SignResponse> {
  const { privateKey } = await requireLocalKey(opts.keyAddress);
  const account = privateKeyToAccount(privateKey);

  const postSignature = async (
    signingHash: `0x${string}`,
  ): Promise<SignResponse> => {
    const signature = await signHash(privateKey, signingHash);
    return httpRequest<SignResponse>(env, `/transactions/${txId}/sign`, {
      method: "PUT",
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

type MessageResponse = {
  data: {
    id: string;
    accountAddress: string;
    chainId: number;
    name: string;
    dataType: string;
    data: string;
    signingHash: string | null;
    signatureCount: number;
    threshold: number;
    signature: string | null;
    createdAt: string;
  };
};

export async function signMessageLocally(
  env: Credentials,
  opts: {
    address: string;
    messageId?: string;
    create?: Record<string, unknown>;
    keyAddress?: string;
  },
): Promise<MessageResponse> {
  const { privateKey } = await requireLocalKey(opts.keyAddress);
  const account = privateKeyToAccount(privateKey);
  const messagesPath = `/org/accounts/${opts.address}/messages`;

  const message = opts.messageId
    ? await httpRequest<MessageResponse>(
        env,
        `${messagesPath}/${opts.messageId}`,
        { requireAuth: true },
      )
    : await httpRequest<MessageResponse>(env, messagesPath, {
        method: "POST",
        requireAuth: true,
        body: opts.create,
      });

  if (message.data.signature !== null) return message;

  const signingHash = assertSigningHash({
    hash: message.data.signingHash,
    missingCode: "message-not-cli-signable",
    missingMessage: `Message ${message.data.id} does not expose a signingHash. Sign via the web app.`,
  });

  try {
    return await httpRequest<MessageResponse>(
      env,
      `${messagesPath}/${message.data.id}/sign`,
      {
        method: "PUT",
        requireAuth: true,
        body: {
          eoaSigner: account.address,
          signature: await signHash(privateKey, signingHash),
        },
      },
    );
  } catch (err) {
    if (err instanceof SplitsApiError && err.splitsCode === "UNIQUE_SIGNER") {
      return httpRequest<MessageResponse>(
        env,
        `${messagesPath}/${message.data.id}`,
        { requireAuth: true },
      );
    }
    if (err instanceof SplitsApiError && err.splitsCode === "INVALID_SIGNER") {
      throw new SplitsApiError(
        "signer-not-authorized",
        err.status,
        `Local key ${account.address} is not a signer of account ${opts.address}. ` +
          `Another signer can sign message ${message.data.id} with --id.`,
      );
    }
    throw err;
  }
}
