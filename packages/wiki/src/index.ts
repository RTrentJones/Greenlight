/** Greenlight's knowledge plane (vision 03 §3). M0: the schemas every later module builds on. */
export * from './schema';
// Bench grading (roadmap M1-04): the trajectory rule DSL, the uniform grader interface, and the
// grader mutation check behind `bench check-graders`.
export * from './bench/trajectory';
export * from './bench/grader-api';
export * from './bench/check-graders';
export {
  EvidenceIdentitySchema,
  EvidenceRefSchema,
  RawRecordSchema,
  RetainedEvidenceSchema,
  type EvidenceIdentity,
  type EvidenceRef,
  type RawRecord,
  type RetainedEvidence,
} from '@rtrentjones/greenlight-shared';
