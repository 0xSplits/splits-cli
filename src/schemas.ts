import { z } from "incur";

export const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

export const transactionId = z.string().uuid("Invalid transaction ID");
