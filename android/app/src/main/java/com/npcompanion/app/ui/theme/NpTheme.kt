package com.npcompanion.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Matches the palette already established for the desktop chat/history windows
// (src/renderer/chat/chat.css, src/renderer/history/history.css), derived from
// NP's actual character art (mint-teal hair/necktie, dark navy accents) - kept
// identical across desktop and mobile for visual consistency.
private val NpUserBubble = Color(0xFF2F9C90)
private val NpAssistantBubble = Color(0xFF202F38)
private val NpAssistantText = Color(0xFFDCF3EF)
private val NpHeaderText = Color(0xFFB8E3DD)
private val NpPanelBackground = Color(0xFF111E20)

private val NpColorScheme = darkColorScheme(
    primary = NpUserBubble,
    onPrimary = Color.White,
    primaryContainer = NpUserBubble,
    onPrimaryContainer = Color.White,
    secondaryContainer = NpAssistantBubble,
    onSecondaryContainer = NpAssistantText,
    background = NpPanelBackground,
    onBackground = NpHeaderText,
    surface = NpPanelBackground,
    onSurface = NpHeaderText,
)

// Always dark, regardless of system theme - the desktop windows are always
// dark too, and this is meant to look like the same app, not adapt to the
// phone's light/dark setting independently.
@Composable
fun NpTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = NpColorScheme, content = content)
}
