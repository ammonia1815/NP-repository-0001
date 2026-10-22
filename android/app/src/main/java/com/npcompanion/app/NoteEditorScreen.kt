package com.npcompanion.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// One editor for both note files (which = "record" or "memo", see
// NOTE_FILES in files.ts) - a plain "load whole file / edit / save whole
// file" text box, the same thing a desktop user does by opening the file
// directly, just reachable from the phone. Which one NP itself can write to
// is a separate, server-side-enforced restriction (write_record_file only
// ever touches "record") that has nothing to do with what the owner can edit
// here from either file.
@Composable
fun NoteEditorScreen(prefs: Prefs, which: String, title: String, description: String, onBack: () -> Unit) {
    val client = remember(prefs.baseUrl, prefs.token) { NpApiClient(prefs.baseUrl, prefs.token) }
    val scope = rememberCoroutineScope()

    var content by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var savedJustNow by remember { mutableStateOf(false) }

    LaunchedEffect(which) {
        isLoading = true
        errorText = null
        when (val r = client.getNote(which)) {
            is ApiResult.Success -> content = r.data.content
            is ApiResult.HttpError -> errorText = if (r.code == 401) "인증 실패. 설정에서 토큰을 확인해주세요." else r.message
            is ApiResult.NetworkError -> errorText = "서버에 연결할 수 없어요."
        }
        isLoading = false
    }

    fun save() {
        scope.launch {
            isSaving = true
            errorText = null
            savedJustNow = false
            when (val r = client.saveNote(which, content)) {
                is ApiResult.Success -> savedJustNow = true
                is ApiResult.HttpError -> errorText = r.message
                is ApiResult.NetworkError -> errorText = "서버에 연결할 수 없어요."
            }
            isSaving = false
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "뒤로",
                    tint = MaterialTheme.colorScheme.onBackground
                )
            }
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
        }
        HorizontalDivider()

        Text(
            description,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        )

        if (isLoading) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(24.dp),
                horizontalArrangement = Arrangement.Center
            ) {
                CircularProgressIndicator()
            }
        } else {
            OutlinedTextField(
                value = content,
                onValueChange = {
                    content = it
                    savedJustNow = false
                },
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 16.dp)
            )

            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Button(onClick = { save() }, enabled = !isSaving) {
                    Text(if (isSaving) "저장 중..." else "저장")
                }
                if (savedJustNow) {
                    Text(
                        "저장됨",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(start = 12.dp)
                    )
                }
            }

            errorText?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
                )
            }
        }
    }
}
