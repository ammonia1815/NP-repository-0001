package com.npcompanion.app

import android.view.LayoutInflater
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView

// Fills and crops (RESIZE_MODE_ZOOM) rather than letterboxing like AvatarView
// does - this is a full-bleed background sitting behind everything else, not
// content whose edges need to stay fully visible. Reuses the same
// texture_view layout as the avatar (see that layout's own comment for why
// PlayerView's default SurfaceView was avoided).
@OptIn(UnstableApi::class)
@Composable
fun BackgroundVideoView(modifier: Modifier = Modifier, player: BackgroundVideoPlayer) {
    DisposableEffect(Unit) {
        onDispose { player.release() }
    }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx ->
            (LayoutInflater.from(ctx).inflate(R.layout.avatar_player_view, null) as PlayerView).apply {
                this.player = player.exoPlayer
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            }
        }
    )
}
