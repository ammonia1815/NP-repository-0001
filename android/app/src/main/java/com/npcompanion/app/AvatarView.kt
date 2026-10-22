package com.npcompanion.app

import android.view.LayoutInflater
import android.view.TextureView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView

// Source frames are 576x1008 (4:7) - the video assets keep that same ratio,
// so the PlayerView is told to fit (not crop/stretch) within whatever space
// this composable is given, matching the desktop canvas's object-fit:contain.
//
// Inflated from res/layout/avatar_player_view.xml rather than constructed
// directly (PlayerView(context)) so it can use a TextureView-backed surface
// instead of PlayerView's default SurfaceView - see that layout file's
// comment for why (a real, motion-dependent noise artifact was observed on
// a Samsung device with the SurfaceView default).
@OptIn(UnstableApi::class)
@Composable
fun AvatarView(modifier: Modifier = Modifier, avatarPlayer: AvatarPlayer) {
    val context = LocalContext.current

    DisposableEffect(Unit) {
        onDispose { avatarPlayer.release() }
    }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx ->
            (LayoutInflater.from(ctx).inflate(R.layout.avatar_player_view, null) as PlayerView).apply {
                player = avatarPlayer.exoPlayer
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                // setBackgroundColor(TRANSPARENT) above only affects this
                // ViewGroup's own background - the actual TextureView surface
                // it wraps defaults to opaque, so FIT mode's letterbox margins
                // were painting solid black over whatever sits behind this
                // view (the background video) instead of showing it through.
                (videoSurfaceView as? TextureView)?.isOpaque = false
            }
        }
    )
}
