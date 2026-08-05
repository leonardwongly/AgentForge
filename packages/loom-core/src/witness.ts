/**
 * @agentforge/loom-core — witnessed trust and consistency (Phase 5, spec §15).
 *
 * A checkpoint (a ledger head / State address) is independently signed by a set
 * of witnesses. A quorum of valid signatures attests to the checkpoint, enabling
 * split-view detection and offline verification: a fork is undetected only if a
 * quorum of witnesses signs two conflicting checkpoints, which is prevented by
 * each witness signing exactly one checkpoint per sequence.
 *
 * Signatures here use HMAC-SHA256 per witness key (a simplified stand-in for the
 * asymmetric witness keys a production deployment would use), so the quorum and
 * consistency logic is fully exercised and testable.
 */

import { createHmac } from "node:crypto";

export interface WitnessSignature {
  readonly witnessDid: string;
  readonly checkpointCid: string;
  readonly sequence: number;
  readonly signature: string;
}

export class WitnessSet {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(keys: ReadonlyArray<{ readonly did: string; readonly key: Uint8Array }>) {
    for (const { did, key } of keys) {
      this.keys.set(did, key);
    }
  }

  /** Sign a checkpoint at a sequence with a witness key. */
  sign(witnessDid: string, checkpointCid: string, sequence: number): WitnessSignature {
    const key = this.keys.get(witnessDid);
    if (key === undefined) {
      throw new Error(`loom: unknown witness ${witnessDid}`);
    }
    const signature = this.hmac(key, checkpointCid, sequence);
    return { witnessDid, checkpointCid, sequence, signature };
  }

  /** Verify a single witness signature. */
  verify(signature: WitnessSignature): boolean {
    const key = this.keys.get(signature.witnessDid);
    if (key === undefined) {
      return false;
    }
    return this.hmac(key, signature.checkpointCid, signature.sequence) === signature.signature;
  }

  /** True if at least `quorum` distinct witnesses validly sign the checkpoint. */
  quorumReached(signatures: readonly WitnessSignature[], checkpointCid: string, quorum: number): boolean {
    if (quorum < 1 || quorum > this.keys.size) {
      return false;
    }
    const valid = new Set<string>();
    for (const signature of signatures) {
      if (
        signature.checkpointCid === checkpointCid &&
        this.verify(signature) &&
        this.keys.has(signature.witnessDid)
      ) {
        valid.add(signature.witnessDid);
      }
    }
    return valid.size >= quorum;
  }

  /**
   * Detect a split view: two different checkpoints both reaching quorum at the
   * same sequence. Returns true if a fork is undetected (bad).
   */
  detectFork(
    a: readonly WitnessSignature[],
    b: readonly WitnessSignature[],
    sequence: number,
    quorum: number
  ): boolean {
    const aCheckpoints = new Set(a.filter((s) => s.sequence === sequence).map((s) => s.checkpointCid));
    const bCheckpoints = new Set(b.filter((s) => s.sequence === sequence).map((s) => s.checkpointCid));
    for (const cidA of aCheckpoints) {
      if (this.quorumReached(a, cidA, quorum) && bCheckpoints.has(cidA)) {
        return false; // consistent: same checkpoint witnessed
      }
    }
    // If both reach quorum on different checkpoints, that's a fork.
    const aCids = [...aCheckpoints].filter((cid) => this.quorumReached(a, cid, quorum));
    const bCids = [...bCheckpoints].filter((cid) => this.quorumReached(b, cid, quorum));
    return aCids.length > 0 && bCids.length > 0 && aCids.some((cid) => !bCids.includes(cid));
  }

  private hmac(key: Uint8Array, checkpointCid: string, sequence: number): string {
    return createHmac("sha256", key)
      .update(`loom-witness-v1|${sequence}|${checkpointCid}`)
      .digest("base64");
  }
}
