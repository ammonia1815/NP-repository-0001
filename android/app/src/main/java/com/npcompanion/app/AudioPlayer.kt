package com.npcompanion.app

import android.content.Context
import android.media.MediaPlayer
import android.util.Base64
import java.io.File
import java.io.FileOutputStream

// A single reused cache file rather than a data: URI - MediaPlayer does not
// reliably support data: URIs across Android versions/OEMs, but a plain
// file path always works.
class AudioPlayer(private val context: Context) {
    private var mediaPlayer: MediaPlayer? = null

    fun playBase64Wav(base64: String) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val file = File(context.cacheDir, "np_reply.wav")
            FileOutputStream(file).use { it.write(bytes) }

            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener { player -> player.release() }
                prepare()
                start()
            }
        } catch (e: Exception) {
            // Voice playback is a nice-to-have on top of the text reply
            // already shown in the chat list - a failure here shouldn't
            // surface as a user-facing chat error.
        }
    }

    fun release() {
        mediaPlayer?.release()
        mediaPlayer = null
    }
}
