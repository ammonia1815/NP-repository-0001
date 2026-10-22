package com.npcompanion.app

import android.content.Context
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Reading the URI's bytes and base64-encoding them is blocking I/O - keep it
// off the caller's dispatcher (called right before sending, from the same
// coroutine that's about to do the network call anyway).
suspend fun uriToImagePayload(context: Context, uri: Uri): ImagePayload? = withContext(Dispatchers.IO) {
    try {
        val mediaType = context.contentResolver.getType(uri) ?: "image/jpeg"
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null
        ImagePayload(data = Base64.encodeToString(bytes, Base64.NO_WRAP), mediaType = mediaType)
    } catch (e: Exception) {
        null
    }
}
