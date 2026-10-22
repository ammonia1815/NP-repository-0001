package com.npcompanion.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class HttpError(val code: Int, val message: String) : ApiResult<Nothing>()
    data class NetworkError(val cause: Throwable) : ApiResult<Nothing>()
}

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isCancelled) return
            cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
    cont.invokeOnCancellation {
        try {
            cancel()
        } catch (_: Throwable) {
        }
    }
}

// Replies routinely take 5-20s+ (LLM call + TTS synthesis on the desktop
// side), so default OkHttp timeouts (~10s) would false-fire mid-reply -
// these must stay generous.
class NpApiClient(private val baseUrl: String, private val token: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    private fun authorizedRequest(path: String): Request.Builder =
        Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $token")

    // Deliberately does not check the token - /health is unauthenticated on
    // the server, so this only confirms the address is reachable at all.
    suspend fun checkHealth(): Boolean {
        return try {
            val request = Request.Builder().url(baseUrl.trimEnd('/') + "/health").build()
            client.newCall(request).await().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    // /api/message streams newline-delimited JSON (see http-server.ts) so the
    // avatar can react to "thinking"/"searching" state changes as they happen
    // server-side, rather than only finding out after the whole reply is
    // ready. `onState` fires for each state line; the function returns once
    // the terminal "result" (or "error") line arrives.
    suspend fun sendMessageStreaming(
        text: String,
        images: List<ImagePayload> = emptyList(),
        onState: (String) -> Unit
    ): ApiResult<MessageResponse> {
        val body = json.encodeToString(
            MessageRequest.serializer(),
            MessageRequest(text, images.ifEmpty { null })
        ).toRequestBody(JSON_MEDIA_TYPE)
        val request = authorizedRequest("/api/message").post(body).build()

        return try {
            client.newCall(request).await().use { response ->
                if (!response.isSuccessful) {
                    val bodyString = response.body?.string().orEmpty()
                    val message = try {
                        json.decodeFromString(ErrorResponse.serializer(), bodyString).error
                    } catch (e: Exception) {
                        "HTTP ${response.code}"
                    }
                    return ApiResult.HttpError(response.code, message)
                }

                // readUtf8Line() blocks waiting for each line - keep this off
                // the caller's (likely Main) dispatcher.
                withContext(Dispatchers.IO) {
                    val source = response.body?.source()
                        ?: return@withContext ApiResult.HttpError(response.code, "empty body")
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isBlank()) continue
                        val parsed = json.decodeFromString(StreamLine.serializer(), line)
                        when (parsed.type) {
                            // onState ultimately calls into ExoPlayer
                            // (AvatarPlayer.requestState), which - like all
                            // Player methods - must only ever be touched from
                            // the thread it was created on (Main). Calling it
                            // from this IO-dispatcher read loop silently
                            // misbehaves rather than throwing, which is why
                            // the avatar never visibly changed state.
                            "state" -> parsed.state?.let { state ->
                                withContext(Dispatchers.Main) { onState(state) }
                            }
                            "result" -> return@withContext ApiResult.Success(
                                MessageResponse(
                                    reply = parsed.reply ?: "",
                                    emotion = parsed.emotion ?: "idle",
                                    audio = parsed.audio
                                )
                            )
                            "error" -> return@withContext ApiResult.HttpError(500, parsed.error ?: "internal_error")
                        }
                    }
                    ApiResult.HttpError(500, "stream ended without a result")
                }
            }
        } catch (e: IOException) {
            ApiResult.NetworkError(e)
        }
    }

    suspend fun getHistory(limit: Int = 50): ApiResult<HistoryResponse> {
        val request = authorizedRequest("/api/history?limit=$limit").get().build()
        return execute(request) { json.decodeFromString(HistoryResponse.serializer(), it) }
    }

    // start/end are YYYY-MM-DD (inclusive) - backs the 이전 대화 검색 screen.
    suspend fun getHistoryRange(start: String, end: String): ApiResult<HistoryResponse> {
        val request = authorizedRequest("/api/history?start=$start&end=$end").get().build()
        return execute(request) { json.decodeFromString(HistoryResponse.serializer(), it) }
    }

    // start/end are YYYY-MM-DD; categories is a subset of work/diet/exercise/sleep.
    suspend fun getHealthRecords(start: String, end: String, categories: Set<String>): ApiResult<HealthRecordsResponse> {
        val categoriesParam = categories.joinToString(",")
        val request = authorizedRequest("/api/health-records?start=$start&end=$end&categories=$categoriesParam").get().build()
        return execute(request) { json.decodeFromString(HealthRecordsResponse.serializer(), it) }
    }

    // which is "record" or "memo" (see files.ts's NOTE_FILES). Both are
    // readable/writable from here regardless of which one NP itself can only
    // read vs. read+write - that distinction is about NP's own tool access,
    // not what the owner can do with their own files from their own phone.
    suspend fun getNote(which: String): ApiResult<NoteContent> {
        val request = authorizedRequest("/api/notes/$which").get().build()
        return execute(request) { json.decodeFromString(NoteContent.serializer(), it) }
    }

    suspend fun saveNote(which: String, content: String): ApiResult<Unit> {
        val body = json.encodeToString(NoteContent.serializer(), NoteContent(content)).toRequestBody(JSON_MEDIA_TYPE)
        val request = authorizedRequest("/api/notes/$which").post(body).build()
        return execute(request) {}
    }

    // Controls the actual desktop GPT-SoVITS engine - shared by every
    // connected client, not a per-device mute (see http-server.ts's
    // /api/tts-state and /api/tts-toggle).
    suspend fun getTtsState(): ApiResult<TtsStateResponse> {
        val request = authorizedRequest("/api/tts-state").get().build()
        return execute(request) { json.decodeFromString(TtsStateResponse.serializer(), it) }
    }

    suspend fun toggleTts(): ApiResult<TtsStateResponse> {
        val request = authorizedRequest("/api/tts-toggle").post("".toRequestBody(JSON_MEDIA_TYPE)).build()
        return execute(request) { json.decodeFromString(TtsStateResponse.serializer(), it) }
    }

    // Mirrors the desktop avatar's own provider-switch menu (see
    // http-server.ts's /api/provider) - all four assistant instances already
    // exist server-side, so this is a plain instant set like the desktop
    // side, not an off/starting/on sequence like TTS.
    suspend fun getProvider(): ApiResult<ProviderResponse> {
        val request = authorizedRequest("/api/provider").get().build()
        return execute(request) { json.decodeFromString(ProviderResponse.serializer(), it) }
    }

    suspend fun setProvider(name: String): ApiResult<ProviderResponse> {
        val body = json.encodeToString(ProviderRequest.serializer(), ProviderRequest(name)).toRequestBody(JSON_MEDIA_TYPE)
        val request = authorizedRequest("/api/provider").post(body).build()
        return execute(request) { json.decodeFromString(ProviderResponse.serializer(), it) }
    }

    private suspend fun <T> execute(request: Request, parse: (String) -> T): ApiResult<T> {
        return try {
            client.newCall(request).await().use { response ->
                val bodyString = response.body?.string().orEmpty()
                if (response.isSuccessful) {
                    ApiResult.Success(parse(bodyString))
                } else {
                    val message = try {
                        json.decodeFromString(ErrorResponse.serializer(), bodyString).error
                    } catch (e: Exception) {
                        "HTTP ${response.code}"
                    }
                    ApiResult.HttpError(response.code, message)
                }
            }
        } catch (e: IOException) {
            ApiResult.NetworkError(e)
        }
    }
}
