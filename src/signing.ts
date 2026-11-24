// Local EOA signing flow. Fetches the transaction from the backend, checks that
// the calls it returns hash to the digest the signer acknowledged and to the
// server's callsHash, validates the signingHash shape before handing it to
// viem, signs, and PUTs back. Retries once on a stale signer nonce, with the
// same checks on the refetched transaction.

import { Errors, z } from "incur";
import { encodeAbiParameters, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadLocalKey } from "./config.js";
import { type Credentials, httpRequest, SplitsApiError } from "./http.js";
import { bytes32Hash, evmAddress } from "./schemas.js";

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

const callsSchema = z.array(
  z.object({
    to: evmAddress,
    value: z.string().regex(/^\d+$/),
    data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  }),
);

type Call = z.infer<typeof callsSchema>[number];

export type ChainCalls = { chainId: number; calls: Call[] };

type TransactionData = { calls?: unknown };

type TxGetResponse = {
  data: {
    chainId?: number | null;
    dataType?: string;
    signingHash?: string | null;
    callsHash?: string | null;
    transactionData?: TransactionData | null;
    merkleTransactionData?: {
      chainTransactions?: {
        chainId: number;
        transactionData?: TransactionData | null;
      }[];
    } | null;
  };
};

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

const CALLS_HASH_PARAMETERS = [
  {
    type: "tuple[]",
    components: [
      { name: "chainId", type: "uint256" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export const computeCallsHash = (chainCalls: ChainCalls[]): `0x${string}` =>
  keccak256(
    encodeAbiParameters(CALLS_HASH_PARAMETERS, [
      [...chainCalls]
        .sort((a, b) => a.chainId - b.chainId)
        .map(({ chainId, calls }) => ({
          chainId: BigInt(chainId),
          calls: calls.map(({ to, value, data }) => ({
            to: to as `0x${string}`,
            value: BigInt(value),
            data: data as `0x${string}`,
          })),
        })),
    ]),
  );

const callsNotExposed = (txId: string) =>
  new Errors.IncurError({
    code: "CALLS_NOT_EXPOSED",
    message:
      `Transaction ${txId} does not expose its calls or their callsHash, so the CLI cannot show what you would sign. ` +
      "Refusing to sign. Sign via the web app, or retry once the Splits API returns calls.",
  });

const readChainCalls = (
  txId: string,
  tx: TxGetResponse["data"],
): ChainCalls[] => {
  const unparsed =
    tx.dataType === "merkleTransaction"
      ? (tx.merkleTransactionData?.chainTransactions ?? []).map((child) => ({
          chainId: child.chainId,
          calls: child.transactionData?.calls,
        }))
      : [{ chainId: tx.chainId, calls: tx.transactionData?.calls }];
  if (
    unparsed.length === 0 ||
    unparsed.some(
      ({ chainId, calls }) =>
        typeof chainId !== "number" || calls === undefined || calls === null,
    )
  ) {
    throw callsNotExposed(txId);
  }
  return unparsed
    .map(({ chainId, calls }) => {
      const parsed = callsSchema.safeParse(calls);
      if (!parsed.success) {
        throw new Errors.IncurError({
          code: "INVALID_CALLS",
          message: `Backend returned malformed calls for transaction ${txId} on chain ${chainId}. Refusing to sign.`,
        });
      }
      return { chainId: chainId as number, calls: parsed.data };
    })
    .sort((a, b) => a.chainId - b.chainId);
};

type SignableTransaction = {
  signingHash: `0x${string}`;
  callsHash: `0x${string}`;
  chainCalls: ChainCalls[];
};

const fetchSignableTransaction = async (
  env: Credentials,
  txId: string,
): Promise<SignableTransaction> => {
  const tx = await httpRequest<TxGetResponse>(env, `/transactions/${txId}`, {
    requireAuth: true,
  });
  const signingHash = assertSigningHash({
    hash: tx.data.signingHash,
    missingCode: "transaction-not-cli-signable",
    missingMessage:
      "This transaction does not expose a signingHash (e.g. some deploy paths). Sign via the web app.",
  });
  const chainCalls = readChainCalls(txId, tx.data);
  if (!bytes32Hash.safeParse(tx.data.callsHash).success) {
    throw callsNotExposed(txId);
  }
  const callsHash = computeCallsHash(chainCalls);
  if ((tx.data.callsHash as string).toLowerCase() !== callsHash) {
    throw new Errors.IncurError({
      code: "SERVER_CALLS_HASH_MISMATCH",
      message:
        `The callsHash the backend returned for transaction ${txId} (${tx.data.callsHash}) does not match its calls (${callsHash}). ` +
        "Refusing to sign.",
    });
  }
  return { signingHash, callsHash, chainCalls };
};

const reviewPayload = (txId: string, signable: SignableTransaction) =>
  JSON.stringify(
    {
      transactionId: txId,
      callsHash: signable.callsHash,
      chains: signable.chainCalls,
    },
    null,
    2,
  );

const assertCallsAcknowledged = ({
  txId,
  acknowledgedCallsHash,
  signable,
}: {
  txId: string;
  acknowledgedCallsHash: string | undefined;
  signable: SignableTransaction;
}) => {
  const signCommand = `splits transactions sign ${txId} --calls-hash ${signable.callsHash}`;
  if (acknowledgedCallsHash === undefined) {
    throw new Errors.IncurError({
      code: "CALLS_HASH_REQUIRED",
      message:
        `Nothing was signed. Review the calls of transaction ${txId} below. ` +
        `If they are what you expect, sign them with \`${signCommand}\` (MCP: pass callsHash).\n` +
        reviewPayload(txId, signable),
    });
  }
  if (acknowledgedCallsHash.toLowerCase() !== signable.callsHash) {
    throw new Errors.IncurError({
      code: "CALLS_HASH_MISMATCH",
      message:
        `Nothing was signed. The calls of transaction ${txId} hash to ${signable.callsHash}, not ${acknowledgedCallsHash}. ` +
        `The calls may have changed since you reviewed them. Review the calls below; ` +
        `if they are what you expect, sign them with \`${signCommand}\` (MCP: pass callsHash).\n` +
        reviewPayload(txId, signable),
    });
  }
};

const fetchAcknowledgedSigningHash = async ({
  env,
  txId,
  acknowledgedCallsHash,
}: {
  env: Credentials;
  txId: string;
  acknowledgedCallsHash: string | undefined;
}): Promise<`0x${string}`> => {
  const signable = await fetchSignableTransaction(env, txId);
  assertCallsAcknowledged({ txId, acknowledgedCallsHash, signable });
  return signable.signingHash;
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
  opts: {
    submit: boolean;
    keyAddress?: string;
    callsHash: string | undefined;
  },
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

  const fetchSigningHash = () =>
    fetchAcknowledgedSigningHash({
      env,
      txId,
      acknowledgedCallsHash: opts.callsHash,
    });

  const signingHash = await fetchSigningHash();
  try {
    return await postSignature(signingHash);
  } catch (err) {
    // Nonce-stale races happen under active multisig use; retry once with a
    // fresh GET, the same calls checks, and a re-sign. A second failure is
    // surfaced verbatim.
    if (
      err instanceof SplitsApiError &&
      err.splitsCode === "INVALID_SIGNER_NONCE"
    ) {
      const freshHash = await fetchSigningHash();
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
