package com.npcompanion.app

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

// A single always-looping clip behind the whole screen - unlike AvatarPlayer,
// there's no state machine here since the background never changes what it's
// showing. The asset itself is already a ping-pong loop (forward + reverse)
// baked in at encode time, so REPEAT_MODE_ALL alone gives a seamless loop.
class BackgroundVideoPlayer(context: Context) {
    val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()

    init {
        exoPlayer.repeatMode = Player.REPEAT_MODE_ALL
        // The asset has no audio track at all, but muting explicitly costs
        // nothing and documents the intent regardless.
        exoPlayer.volume = 0f
        exoPlayer.setMediaItem(MediaItem.fromUri("asset:///background/background_loop.mp4"))
        exoPlayer.prepare()
        exoPlayer.play()
    }

    fun release() {
        exoPlayer.release()
    }
}
