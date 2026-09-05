/**
 * loom CLI engine — the testable core that ties the Loom slices together:
 * git refs -> Loom States (git-bridge) -> governance decision (ratify) ->
 * optional signed provenance (provenance). No process/fs/child_process here so
 * it runs against a fake GitReader in tests.
 */
import type { PullRequestReview } from "@agentforge/core";
import { stateAddress, type Cid } from "@agentforge/loom-core";
import { transformSetFromGit, type GitReader } from "@agentforge/loom-git-bridge";
import {
  buildDeterministicCheckStatement,
  signStatement,
  transitionSubjectCid,
  verifyProvenance,
  type DsseEnvelope,
  type KeyPair,
  type VerifyResult
} from "@agentforge/loom-provenance";
import { evaluateTransformSet, type TransformEvaluation } from "@agentforge/loom-ratify";
import { parsePolicyYaml } from "@agentforge/policy";

export interface SignOptions {
  readonly key: KeyPair;
  readonly checkerDid: string;
  readonly detectorSuiteVersion: string;
  readonly policyVersion: string;
}

export interface RatifyRequest {
  readonly reader: GitReader;
  readonly baseRef: string;
  readonly headRef: string;
  readonly policyYaml: string;
  readonly space: string;
  readonly lineRef: string;
  readonly proposalId: string;
  readonly title: string;
  readonly author: string;
  readonly reviews?: ReadonlyArray<PullRequestReview> | undefined;
  readonly sign?: SignOptions | undefined;
}

export interface RatifyResult {
  readonly evaluation: TransformEvaluation;
  readonly baseAddress: Cid;
  readonly resultAddress: Cid;
  readonly subjectAddress: Cid;
  readonly envelope?: DsseEnvelope | undefined;
}

/** Ratify a base->head git change through the Loom governance engine. */
export async function ratify(req: RatifyRequest): Promise<RatifyResult> {
  const parsed = parsePolicyYaml(req.policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`policy invalid: ${parsed.errors.join("; ")}`);
  }
  const { base, result } = await transformSetFromGit(req.reader, req.baseRef, req.headRef);
  const evaluation = evaluateTransformSet({
    base,
    result,
    policy: parsed.config,
    space: req.space,
    lineRef: req.lineRef,
    proposalId: req.proposalId,
    intent: { title: req.title },
    author: req.author,
    ...(req.reviews ? { reviews: req.reviews } : {})
  });
  const baseAddress = stateAddress(base);
  const resultAddress = stateAddress(result);
  const subjectAddress = transitionSubjectCid({
    baseState: baseAddress,
    resultState: resultAddress
  });

  if (!req.sign) {
    return { evaluation, baseAddress, resultAddress, subjectAddress };
  }
  const statement = buildDeterministicCheckStatement({
    checkerDid: req.sign.checkerDid,
    detectorSuiteVersion: req.sign.detectorSuiteVersion,
    baseState: baseAddress,
    resultState: resultAddress,
    policyVersion: req.sign.policyVersion,
    facts: evaluation.facts,
    decision: evaluation.result.status
  });
  const envelope = signStatement(statement, req.sign.key);
  return { evaluation, baseAddress, resultAddress, subjectAddress, envelope };
}

export interface VerifyRequest {
  readonly reader: GitReader;
  readonly baseRef: string;
  readonly headRef: string;
  readonly envelope: DsseEnvelope;
  readonly publicKeyPem: string;
  readonly policyVersion: string;
}

export interface CliVerifyResult {
  readonly verdict: VerifyResult;
  readonly baseAddress: Cid;
  readonly resultAddress: Cid;
  readonly subjectAddress: Cid;
}

/**
 * Independently verify an attestation: re-derive both base and head State
 * addresses from the repo, then confirm the signature, subject, and predicate
 * bind the signed decision to that exact transition.
 */
export async function verifyAttestation(req: VerifyRequest): Promise<CliVerifyResult> {
  const { base, result } = await transformSetFromGit(req.reader, req.baseRef, req.headRef);
  const baseAddress = stateAddress(base);
  const resultAddress = stateAddress(result);
  const subjectAddress = transitionSubjectCid({
    baseState: baseAddress,
    resultState: resultAddress
  });
  const verdict = verifyProvenance({
    baseState: baseAddress,
    resultState: resultAddress,
    policyVersion: req.policyVersion,
    envelope: req.envelope,
    publicKeyPem: req.publicKeyPem
  });
  return { verdict, baseAddress, resultAddress, subjectAddress };
}
