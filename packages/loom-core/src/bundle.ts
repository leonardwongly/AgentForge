/**
 * @agentforge/loom-core — verification bundles and multi-authority
 * reconciliation (Phase 5, spec §15).
 *
 * A verification bundle packages a checkpoint with the witness signatures that
 * attest to it, so a checkpoint can be verified offline (without the issuing
 * authority). Reconcile compares two authorities' bundles to detect a split
 * view: if both reach quorum on different checkpoints at the same sequence, a
 * fork is detected.
 */

import { WitnessSet, type WitnessSignature } from "./witness.js";

export interface VerificationBundle {
  readonly checkpointCid: string;
  readonly sequence: number;
  readonly signatures: readonly WitnessSignature[];
  readonly authority: string;
}

/** Package a checkpoint and its witness signatures into a bundle. */
export function createVerificationBundle(
  authority: string,
  checkpointCid: string,
  sequence: number,
  signatures: readonly WitnessSignature[]
): VerificationBundle {
  return { authority, checkpointCid, sequence, signatures };
}

/** Offline verification: the bundle's signatures reach quorum on its checkpoint. */
export function verifyBundle(
  bundle: VerificationBundle,
  witnesses: WitnessSet,
  quorum: number
): boolean {
  return witnesses.quorumReached(bundle.signatures, bundle.checkpointCid, quorum);
}

export type ReconcileResult =
  | { readonly consistent: true }
  | { readonly consistent: false; readonly reason: "fork" | "no_quorum"; readonly detail: string };

/**
 * Reconcile two authorities' bundles for the same sequence. Returns a fork
 * (inconsistent) if both reach quorum on different checkpoints, or no_quorum if
 * either fails to reach quorum.
 */
export function reconcile(
  a: VerificationBundle,
  b: VerificationBundle,
  witnesses: WitnessSet,
  quorum: number
): ReconcileResult {
  if (a.sequence !== b.sequence) {
    return { consistent: false, reason: "no_quorum", detail: "bundles are for different sequences" };
  }
  const aOk = verifyBundle(a, witnesses, quorum);
  const bOk = verifyBundle(b, witnesses, quorum);
  if (!aOk || !bOk) {
    return { consistent: false, reason: "no_quorum", detail: "one or both bundles lack quorum" };
  }
  if (a.checkpointCid !== b.checkpointCid) {
    return {
      consistent: false,
      reason: "fork",
      detail: `authorities ${a.authority} and ${b.authority} witnessed different checkpoints`
    };
  }
  return { consistent: true };
}
