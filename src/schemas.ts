import { z } from "incur";

export const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

export const transactionId = z.string().uuid("Invalid transaction ID");

// 32-byte (bytes32) hex hashes used for transactionHash and userOpHash.
// Canonical lowercase form is what viem produces; the API also lowercases on
// input, so callers can pass either casing here.
export const bytes32Hash = z
  .string()
  .regex(
    /^0x[a-fA-F0-9]{64}$/,
    "Must be a 0x-prefixed 32-byte (64 hex char) hex string",
  );
