package com.npcompanion.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// Pre-fills existing values so re-opening this screen from the chat screen's
// "설정" button (e.g. after a 401) edits in place instead of forcing the
// user to re-type an address/token that was already fine.
@Composable
fun SetupScreen(prefs: Prefs, onSaved: () -> Unit) {
    var baseUrl by remember { mutableStateOf(prefs.baseUrl.ifBlank { "https://" }) }
    var token by remember { mutableStateOf(prefs.token) }
    var status by remember { mutableStateOf<String?>(null) }
    var isChecking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("엔피 서버 연결", style = MaterialTheme.typography.headlineSmall)
        Spacer(modifier = Modifier.height(16.dp))
        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            label = { Text("서버 주소 (예: https://your-name.duckdns.org)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API 토큰") },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true
        )
        Spacer(modifier = Modifier.height(16.dp))
        status?.let {
            Text(it, modifier = Modifier.padding(bottom = 8.dp))
        }
        Button(
            enabled = !isChecking && baseUrl.isNotBlank() && token.isNotBlank(),
            onClick = {
                val trimmedUrl = baseUrl.trim().trimEnd('/')
                val trimmedToken = token.trim()
                isChecking = true
                status = "연결 확인 중..."
                scope.launch {
                    val ok = NpApiClient(trimmedUrl, trimmedToken).checkHealth()
                    isChecking = false
                    if (ok) {
                        prefs.baseUrl = trimmedUrl
                        prefs.token = trimmedToken
                        onSaved()
                    } else {
                        status = "서버에 연결할 수 없어요. 주소를 확인해주세요."
                    }
                }
            }
        ) {
            Text("저장 및 연결 확인")
        }
    }
}
