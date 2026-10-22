package com.npcompanion.app

import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import com.npcompanion.app.ui.theme.NpTheme

private enum class AppScreen { Chat, Settings, Setup, HealthRecords, ChatHistory, RecordNote, MemoNote }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Default Material3 DayNight theme leaves the status bar a generic
        // light purple - match it to NP's actual mint-teal hair/necktie color
        // instead, same palette as the rest of the app (NpTheme.kt).
        window.statusBarColor = AndroidColor.parseColor("#2F9C90")
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false

        // Opts out of the classic auto-resize/pan behavior for the whole
        // window - confirmed for real that classic mode was PANNING the
        // entire window (not resizing it) when the chat screen's message
        // field got focus, sliding NP's avatar up as one rigid unit until
        // her head went off the top of the screen; a fixed-size avatar
        // modifier didn't help because panning isn't a resize, there was
        // nothing to "stay fixed size" against. With this off, nothing moves
        // automatically - the keyboard just overlays the window, and only
        // ChatScreen's own Modifier.imePadding() (applied just to its input
        // row, not the avatar) opts that one piece back into moving.
        // statusBarsPadding()/navigationBarsPadding() below keep every other
        // screen's layout visually unchanged now that the system no longer
        // reserves that space automatically.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContent {
            NpTheme {
                Surface(modifier = Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                    val prefs = remember { Prefs(applicationContext) }
                    // Setup (server address/token) used to be the gear icon's
                    // direct destination; it's now nested one level under the
                    // new Settings screen, reached via its "연결" row - except
                    // on a genuinely first-ever launch with no credentials
                    // yet, which still goes straight to Setup.
                    var screen by remember {
                        mutableStateOf(if (prefs.hasCredentials()) AppScreen.Chat else AppScreen.Setup)
                    }

                    when (screen) {
                        AppScreen.Setup -> SetupScreen(prefs = prefs, onSaved = { screen = AppScreen.Chat })
                        AppScreen.Settings -> SettingsScreen(
                            prefs = prefs,
                            onBack = { screen = AppScreen.Chat },
                            onOpenConnection = { screen = AppScreen.Setup },
                            onOpenHealthRecords = { screen = AppScreen.HealthRecords },
                            onOpenChatHistory = { screen = AppScreen.ChatHistory },
                            onOpenRecordNote = { screen = AppScreen.RecordNote },
                            onOpenMemoNote = { screen = AppScreen.MemoNote }
                        )
                        AppScreen.HealthRecords -> HealthRecordsScreen(
                            prefs = prefs,
                            onBack = { screen = AppScreen.Settings }
                        )
                        AppScreen.ChatHistory -> ChatHistoryScreen(
                            prefs = prefs,
                            onBack = { screen = AppScreen.Settings }
                        )
                        AppScreen.RecordNote -> NoteEditorScreen(
                            prefs = prefs,
                            which = "record",
                            title = "엔피 기록",
                            description = "엔피가 \"기록해줘\"라는 요청에 따라 적어두는 내용이에요. 여기서 직접 고쳐도 되고, 엔피에게 수정을 시켜도 돼요.",
                            onBack = { screen = AppScreen.Settings }
                        )
                        AppScreen.MemoNote -> NoteEditorScreen(
                            prefs = prefs,
                            which = "memo",
                            title = "내 메모",
                            description = "내가 직접 적어두는 메모예요. 엔피는 이 내용을 읽을 수만 있고 고칠 수는 없어요.",
                            onBack = { screen = AppScreen.Settings }
                        )
                        AppScreen.Chat -> ChatScreen(prefs = prefs, onEditSettings = { screen = AppScreen.Settings })
                    }
                }
            }
        }
    }
}
