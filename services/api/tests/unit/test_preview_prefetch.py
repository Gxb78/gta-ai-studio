"""
Tests unitaires pour le prefetch automatique des clips adjacents.
"""
import pytest
from unittest.mock import MagicMock, patch, call
from gta_studio_api.models import ClipPreviewRequest


def test_prefetch_adjacent_clips_no_recursion(service_fixture):
    """Vérifie que les requêtes origin='prefetch' ne déclenchent pas de récursion."""
    service = service_fixture

    # Clip au milieu (index 1 sur 3)
    clips = [
        {"id": "clip-0", "start_ms": 0, "end_ms": 3000},
        {"id": "clip-1", "start_ms": 3000, "end_ms": 6000},
        {"id": "clip-2", "start_ms": 6000, "end_ms": 9000},
    ]

    # Mock start_clip_preview pour compter les appels
    original_start = service.start_clip_preview
    call_count = {"user": 0, "prefetch": 0}

    def mock_start(project_id, request):
        if request.origin == "user":
            call_count["user"] += 1
            # Simuler le comportement réel : appeler _prefetch_adjacent_clips
            service._prefetch_adjacent_clips(project_id, request, clips, clips[1])
        else:
            call_count["prefetch"] += 1
        # Retourner une réponse mock
        return {
            "client_request_id": request.client_request_id,
            "cache_hit": True,
            "status": "ready",
        }

    service.start_clip_preview = mock_start

    # Requête utilisateur sur clip-1 (milieu)
    user_request = ClipPreviewRequest(
        client_request_id="user-req-001",
        edit_project_id="edit-123",
        clip_id="clip-1",
        timeline_revision=1,
        clip_revision=0,
        render_profile="draft",
        preview_window=None,
        origin="user",
    )

    service.start_clip_preview("project-123", user_request)

    # Assertions
    assert call_count["user"] == 1, "Une seule requête user"
    assert call_count["prefetch"] == 2, "Deux prefetch (clip-0 et clip-2)"


def test_prefetch_edge_clips(service_fixture):
    """Vérifie que le prefetch fonctionne aux bords (premier et dernier clip)."""
    service = service_fixture

    clips = [
        {"id": "clip-0", "start_ms": 0, "end_ms": 3000},
        {"id": "clip-1", "start_ms": 3000, "end_ms": 6000},
    ]

    prefetch_calls = []

    def mock_start(project_id, request):
        if request.origin == "prefetch":
            prefetch_calls.append(request.clip_id)
        elif request.origin == "user":
            current_clip = next((c for c in clips if c["id"] == request.clip_id), None)
            service._prefetch_adjacent_clips(project_id, request, clips, current_clip)
        return {"client_request_id": request.client_request_id, "cache_hit": True, "status": "ready"}

    service.start_clip_preview = mock_start

    # Requête sur premier clip
    first_request = ClipPreviewRequest(
        client_request_id="req-first",
        edit_project_id="edit-123",
        clip_id="clip-0",
        timeline_revision=1,
        clip_revision=0,
        render_profile="draft",
        preview_window=None,
        origin="user",
    )

    service.start_clip_preview("project-123", first_request)
    assert prefetch_calls == ["clip-1"], "Prefetch seulement clip suivant"

    prefetch_calls.clear()

    # Requête sur dernier clip
    last_request = ClipPreviewRequest(
        client_request_id="req-last",
        edit_project_id="edit-123",
        clip_id="clip-1",
        timeline_revision=1,
        clip_revision=0,
        render_profile="draft",
        preview_window=None,
        origin="user",
    )

    service.start_clip_preview("project-123", last_request)
    assert prefetch_calls == ["clip-0"], "Prefetch seulement clip précédent"


def test_prefetch_uses_draft_profile(service_fixture):
    """Vérifie que le prefetch utilise toujours draft profile."""
    service = service_fixture

    clips = [
        {"id": "clip-0", "start_ms": 0, "end_ms": 3000},
        {"id": "clip-1", "start_ms": 3000, "end_ms": 6000},
    ]

    prefetch_profiles = []

    def mock_start(project_id, request):
        if request.origin == "prefetch":
            prefetch_profiles.append(request.render_profile)
        elif request.origin == "user":
            service._prefetch_adjacent_clips(project_id, request, clips, clips[0])
        return {"client_request_id": request.client_request_id, "cache_hit": True, "status": "ready"}

    service.start_clip_preview = mock_start

    # Requête utilisateur avec fidelity
    user_request = ClipPreviewRequest(
        client_request_id="req-user",
        edit_project_id="edit-123",
        clip_id="clip-0",
        timeline_revision=1,
        clip_revision=0,
        render_profile="fidelity",  # User demande fidelity
        preview_window=None,
        origin="user",
    )

    service.start_clip_preview("project-123", user_request)

    assert all(p == "draft" for p in prefetch_profiles), "Prefetch doit toujours utiliser draft"


def test_prefetch_fire_and_forget(service_fixture):
    """Vérifie que les erreurs de prefetch ne propagent pas."""
    service = service_fixture

    clips = [
        {"id": "clip-0", "start_ms": 0, "end_ms": 3000},
        {"id": "clip-1", "start_ms": 3000, "end_ms": 6000},
    ]

    def mock_start(project_id, request):
        if request.origin == "prefetch":
            raise Exception("Prefetch error simulated")
        elif request.origin == "user":
            # Ne doit pas propager l'erreur
            service._prefetch_adjacent_clips(project_id, request, clips, clips[0])
        return {"client_request_id": request.client_request_id, "cache_hit": True, "status": "ready"}

    service.start_clip_preview = mock_start

    user_request = ClipPreviewRequest(
        client_request_id="req-user",
        edit_project_id="edit-123",
        clip_id="clip-0",
        timeline_revision=1,
        clip_revision=0,
        render_profile="draft",
        preview_window=None,
        origin="user",
    )

    # Ne doit pas lever d'exception
    result = service.start_clip_preview("project-123", user_request)
    assert result["client_request_id"] == "req-user"


@pytest.fixture
def service_fixture():
    """Fixture mock service pour les tests."""
    from gta_studio_api.service import StudioService
    service = MagicMock(spec=StudioService)
    service._prefetch_adjacent_clips = StudioService._prefetch_adjacent_clips.__get__(service)
    return service
