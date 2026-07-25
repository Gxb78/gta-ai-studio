"""Versioned cross-process contracts for GTA AI Studio."""

from .common import ArtifactRef, BoundingBox, DataPolicy, GameId, Rational, TimeRange
from .editorial import EditorialBrief
from .editing import AdvancedEditClip, AdvancedEditPlan, OverlayCue, SubjectTrackPoint
from .game_adapter import Detection, EntityDetection, FrameRef, GameAdapterDescriptor, GameEntity, GameEvent, NarrativeTemplate, SegmentRef
from .jobs import JobError, JobRun, JobStatus
from .media import MediaAsset, MediaDerivative, VideoSegment
from .narrative import Claim, EvidenceRef, KnowledgeItem, NarrativeBeat, NarrativeMap, ScriptBlock, VerificationReport
from .quality import QualityCheckResult, QualityGateDecision, QualityScore
from .providers import ProviderContext, ProviderDescriptor, ProviderResult
from .timeline import TimelineClip, TimelineProject, TimelineTrack

__all__ = [
    "ArtifactRef",
    "AdvancedEditClip",
    "AdvancedEditPlan",
    "BoundingBox",
    "Claim",
    "EvidenceRef",
    "DataPolicy",
    "EditorialBrief",
    "OverlayCue",
    "EntityDetection",
    "Detection",
    "FrameRef",
    "GameId",
    "GameAdapterDescriptor",
    "GameEntity",
    "GameEvent",
    "JobError",
    "JobRun",
    "JobStatus",
    "KnowledgeItem",
    "MediaAsset",
    "MediaDerivative",
    "NarrativeBeat",
    "NarrativeMap",
    "NarrativeTemplate",
    "ProviderContext",
    "ProviderDescriptor",
    "ProviderResult",
    "QualityCheckResult",
    "QualityGateDecision",
    "QualityScore",
    "Rational",
    "ScriptBlock",
    "SegmentRef",
    "TimeRange",
    "SubjectTrackPoint",
    "TimelineClip",
    "TimelineProject",
    "TimelineTrack",
    "VideoSegment",
    "VerificationReport",
]
