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

import type { WitnessSet } from "./witness.js";
import { type WitnessSignature } from "./witness.js";

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
 * Per-authority quorum configuration for large-scale reconciliation. A
 * default quorum applies to every authority unless a per-authority override
 * raises or lowers it (e.g. a primary authority may demand a stricter quorum
 * than a replica).
 */
export interface QuorumConfig {
  /** Quorum used for an authority with no override. */
  readonly defaultQuorum: number;
  /** Optional per-authority quorum overrides (keyed by authority name). */
  readonly perAuthority?: Readonly<Record<string, number>>;
}

/** Resolve the quorum an authority must reach under a {@link QuorumConfig}. */
export function quorumFor(config: QuorumConfig, authority: string): number {
  return config.perAuthority?.[authority] ?? config.defaultQuorum;
}

export type MultiReconcileResult =
  | { readonly consistent: true; readonly checkpointCid: string }
  | {
      readonly consistent: false;
      readonly reason: "fork" | "no_quorum";
      readonly detail: string;
    };

/**
 * Reconcile any number of authorities' bundles for the same sequence. All
 * bundles must reach their configured quorum and agree on the same checkpoint;
 * otherwise the reconciliation reports `no_quorum` (a bundle lacks quorum or
 * spans a different sequence) or `fork` (two authorities witnessed different
 * checkpoints).
 */
export function reconcileMany(
  bundles: readonly VerificationBundle[],
  witnesses: WitnessSet,
  config: QuorumConfig
): MultiReconcileResult {
  if (bundles.length === 0) {
    return { consistent: false, reason: "no_quorum", detail: "no bundles to reconcile" };
  }
  const sequence = bundles[0]!.sequence;
  for (const bundle of bundles) {
    if (bundle.sequence !== sequence) {
      return {
        consistent: false,
        reason: "no_quorum",
        detail: `bundles span multiple sequences (${sequence} vs ${bundle.sequence})`
      };
    }
    if (!verifyBundle(bundle, witnesses, quorumFor(config, bundle.authority))) {
      return {
        consistent: false,
        reason: "no_quorum",
        detail: `authority ${bundle.authority} lacks quorum`
      };
    }
  }
  const checkpoint = bundles[0]!.checkpointCid;
  for (const bundle of bundles) {
    if (bundle.checkpointCid !== checkpoint) {
      return {
        consistent: false,
        reason: "fork",
        detail: `authorities ${bundles[0]!.authority} and ${bundle.authority} witnessed different checkpoints`
      };
    }
  }
  return { consistent: true, checkpointCid: checkpoint };
}

/**
 * One side of a simulated network partition: a group of authorities that all
 * witnessed the same checkpoint at a sequence.
 */
export interface PartitionGroup {
  readonly name: string;
  readonly checkpointCid: string;
  readonly sequence: number;
  /** Authorities in this partition, each with the signatures they collected. */
  readonly authorities: ReadonlyArray<{
    readonly name: string;
    readonly signatures: readonly WitnessSignature[];
  }>;
}

/**
 * Partition fault-injection: given a set of partition groups (each with its
 * own authorities and the witness signatures they collected), report whether a
 * fork is undetected. A fork is undetected only if two groups both reach their
 * quorum on different checkpoints at the same sequence — the exact failure the
 * witness invariant is designed to surface.
 */
export function detectForkUnderPartition(
  groups: readonly PartitionGroup[],
  witnesses: WitnessSet,
  config: QuorumConfig
): { readonly fork: boolean; readonly detail: string } {
  const reached: Array<{ readonly name: string; readonly checkpointCid: string; readonly sequence: number }> = [];
  for (const group of groups) {
    for (const authority of group.authorities) {
      const quorum = quorumFor(config, authority.name);
      const ok = witnesses.quorumReached(authority.signatures, group.checkpointCid, quorum);
      if (ok) {
        reached.push({ name: `${group.name}/${authority.name}`, checkpointCid: group.checkpointCid, sequence: group.sequence });
      }
    }
  }
  // Compare every pair that reached quorum at the same sequence.
  for (let i = 0; i < reached.length; i += 1) {
    for (let j = i + 1; j < reached.length; j += 1) {
      const a = reached[i]!;
      const b = reached[j]!;
      if (a.sequence === b.sequence && a.checkpointCid !== b.checkpointCid) {
        return {
          fork: true,
          detail: `fork between ${a.name} (${a.checkpointCid}) and ${b.name} (${b.checkpointCid}) at sequence ${a.sequence}`
        };
      }
    }
  }
  return { fork: false, detail: "no partition group reached conflicting quorum" };
}

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
