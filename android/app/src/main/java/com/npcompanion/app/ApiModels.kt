package com.npcompanion.app

import kotlinx.serialization.Serializable

// These mirror the JSON shapes served by src/main/http-server.ts on the
// desktop app - see 엔피 안드로이드 동반 앱 plan, section A4.

@Serializable
data class ImagePayload(val data: String, val mediaType: String)

@Serializable
data class MessageRequest(val text: String, val images: List<ImagePayload>? = null)

@Serializable
data class MessageResponse(
    val reply: String,
    val emotion: String,
    val audio: String? = null
)

@Serializable
data class HistoryTurn(
    val role: String,
    val text: String,
    val emotion: String? = null,
    val timestamp: Long,
    val source: String? = null,
    val hasPhotoAttachment: Boolean = false,
    val hasScreenView: Boolean = false
)

@Serializable
data class HistoryResponse(val turns: List<HistoryTurn>, val maxRangeDays: Int = 30)

// "off" | "starting" | "on" - mirrors the desktop's own ttsStateLabel().
@Serializable
data class TtsStateResponse(val state: String)

// provider is one of "gemini" | "gemini-fast" | "claude" | "local" - mirrors
// the desktop avatar's own provider toggle (see state.ts's ModelProvider).
// options is only present on GET, so it defaults empty for the POST response
// shape (which only echoes the now-current provider).
@Serializable
data class ProviderResponse(val provider: String, val options: List<String> = emptyList())

@Serializable
data class ProviderRequest(val provider: String)

@Serializable
data class ErrorResponse(val error: String)

@Serializable
data class NoteContent(val content: String)

@Serializable
data class WorkRecord(val date: String, val code: String, val hourRange: String)

@Serializable
data class HealthLogRecord(
    val date: String,
    val time: String,
    val timestamp: Long,
    // Epoch ms from the entry's actual date+time (event_time if known, else
    // its creation time) - use this for chronological ordering, not
    // `timestamp`, which for a backfilled entry is only when it was typed in.
    val sortKey: Long = timestamp,
    val text: String,
    val detail: String? = null,
    val calories: Double? = null,
    val alcoholG: Double? = null,
    val sleepHours: Double? = null,
    val mealType: String? = null,
    val assessment: String? = null,
    // 운동-only: 유산소/무산소/복합 (서버에서 이미 한글로 변환되어 옴)
    val exerciseType: String? = null
)

@Serializable
data class HealthRecordsResponse(
    val work: List<WorkRecord> = emptyList(),
    val diet: List<HealthLogRecord> = emptyList(),
    val exercise: List<HealthLogRecord> = emptyList(),
    val sleep: List<HealthLogRecord> = emptyList(),
    val maxRangeDays: Int = 30
)

// /api/message responds as newline-delimited JSON rather than one object -
// each line is one of these, discriminated by `type`. "state" lines carry
// avatar state hints (idle/thinking/searching) as they happen server-side;
// the stream ends with exactly one "result" or "error" line.
@Serializable
data class StreamLine(
    val type: String,
    val state: String? = null,
    val reply: String? = null,
    val emotion: String? = null,
    val audio: String? = null,
    val error: String? = null
)
