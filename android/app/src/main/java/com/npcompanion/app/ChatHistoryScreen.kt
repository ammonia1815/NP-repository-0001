package com.npcompanion.app

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
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
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

private fun LocalDate.toEpochMillisUtc(): Long = atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
private fun Long.toLocalDateUtc(): LocalDate = Instant.ofEpochMilli(this).atZone(ZoneOffset.UTC).toLocalDate()

// Matches history.ts's dateKey()/timeLabel() - local calendar date/time of
// the turn's own timestamp, not the query's UTC-normalized range bounds.
private fun dateKeyLocal(ts: Long): String {
    val d = java.util.Date(ts)
    val cal = java.util.Calendar.getInstance()
    cal.time = d
    return "%04d-%02d-%02d".format(cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH) + 1, cal.get(java.util.Calendar.DAY_OF_MONTH))
}

private fun timeLabelLocal(ts: Long): String {
    val cal = java.util.Calendar.getInstance()
    cal.timeInMillis = ts
    return "%02d:%02d".format(cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE))
}

// 기본값: 오늘 포함 최근 3일 - 매번 날짜를 직접 고르지 않아도 바로 최근 대화가 보이도록.
private const val DEFAULT_RANGE_DAYS = 3L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatHistoryScreen(prefs: Prefs, onBack: () -> Unit) {
    val client = remember(prefs.baseUrl, prefs.token) { NpApiClient(prefs.baseUrl, prefs.token) }
    val scope = rememberCoroutineScope()

    var startDate by remember { mutableStateOf(LocalDate.now().minusDays(DEFAULT_RANGE_DAYS - 1)) }
    var endDate by remember { mutableStateOf(LocalDate.now()) }
    var showStartPicker by remember { mutableStateOf(false) }
    var showEndPicker by remember { mutableStateOf(false) }

    var turns by remember { mutableStateOf<List<HistoryTurn>>(emptyList()) }
    var isLoading by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var maxRangeDays by remember { mutableStateOf(30) }

    // Search only ever operates on the currently fetched range (same as the
    // desktop history window) - widening the date range is how older matches
    // are reached, rather than this re-querying the server on every keystroke.
    val listState = rememberLazyListState()
    var searchQuery by remember { mutableStateOf("") }
    var searchMatches by remember { mutableStateOf<List<Int>>(emptyList()) }
    var searchIndex by remember { mutableStateOf(-1) }
    var lastSearchTerm by remember { mutableStateOf("") }

    val rangeDays = ChronoUnit.DAYS.between(startDate, endDate) + 1
    val rangeValid = rangeDays in 1..maxRangeDays.toLong()

    fun fetch() {
        if (!rangeValid) return
        scope.launch {
            isLoading = true
            errorText = null
            when (val r = client.getHistoryRange(startDate.toString(), endDate.toString())) {
                is ApiResult.Success -> {
                    turns = r.data.turns
                    maxRangeDays = r.data.maxRangeDays
                }
                is ApiResult.HttpError -> errorText = if (r.code == 401) "인증 실패. 설정에서 토큰을 확인해주세요." else r.message
                is ApiResult.NetworkError -> errorText = "서버에 연결할 수 없어요."
            }
            isLoading = false
        }
    }

    LaunchedEffect(Unit) { fetch() }

    val rows = remember(turns) { buildChatRows(turns) }

    // A fresh fetch invalidates any match indices from the previous rows
    // list - without this, "다음 찾기" after changing the date range would
    // scroll to the wrong item or throw on an out-of-range index.
    LaunchedEffect(rows) {
        searchMatches = emptyList()
        searchIndex = -1
        lastSearchTerm = ""
    }

    fun runSearch() {
        val term = searchQuery.trim()
        if (term.isEmpty()) {
            searchMatches = emptyList()
            searchIndex = -1
            lastSearchTerm = ""
            return
        }
        if (term != lastSearchTerm) {
            lastSearchTerm = term
            val lower = term.lowercase()
            searchMatches = rows.withIndex()
                .filter { (_, row) -> row is ChatRow.Turn && row.turn.text.lowercase().contains(lower) }
                .map { it.index }
            searchIndex = -1
        }
        if (searchMatches.isEmpty()) return
        searchIndex = (searchIndex + 1) % searchMatches.size
        scope.launch { listState.animateScrollToItem(searchMatches[searchIndex]) }
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
            Text(
                "이전 대화 검색",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 8.dp)
            )
        }
        HorizontalDivider()

        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
            val compactPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 6.dp)
            // Wider than compactPadding (more horizontal room for the date
            // text) but less tall (4dp vs 6dp vertical) to offset bodyMedium's
            // taller line height than bodySmall - net effect is a visibly
            // bigger date button without actually growing in height.
            val dateButtonPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 4.dp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { showStartPicker = true }, contentPadding = dateButtonPadding) {
                    Text(startDate.toString(), style = MaterialTheme.typography.bodyMedium)
                }
                Text(" ~ ", modifier = Modifier.padding(horizontal = 2.dp))
                OutlinedButton(onClick = { showEndPicker = true }, contentPadding = dateButtonPadding) {
                    Text(endDate.toString(), style = MaterialTheme.typography.bodyMedium)
                }
                androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
                Button(
                    onClick = { fetch() },
                    enabled = rangeValid && !isLoading,
                    contentPadding = compactPadding
                ) {
                    Text(if (isLoading) "조회중" else "조회", style = MaterialTheme.typography.bodySmall)
                }
            }
            if (!rangeValid) {
                Text(
                    "최대 ${maxRangeDays}일까지 조회할 수 있어요 (현재 ${rangeDays}일 선택됨)",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }

            errorText?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 6.dp)
            ) {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text("검색어", style = MaterialTheme.typography.bodySmall) },
                    textStyle = MaterialTheme.typography.bodySmall,
                    singleLine = true,
                    modifier = Modifier.weight(1f).height(48.dp)
                )
                IconButton(onClick = { runSearch() }) {
                    Icon(Icons.Filled.Search, contentDescription = "다음 찾기")
                }
                if (searchMatches.isNotEmpty()) {
                    Text(
                        "${searchIndex + 1}/${searchMatches.size}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else if (lastSearchTerm.isNotEmpty()) {
                    Text(
                        "0/0",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        HorizontalDivider()

        if (isLoading && turns.isEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(24.dp),
                horizontalArrangement = Arrangement.Center
            ) {
                CircularProgressIndicator()
            }
        } else if (turns.isEmpty()) {
            Text(
                "선택한 기간에 대화 기록이 없어요.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp)
            )
        } else {
            val currentMatchRow = searchMatches.getOrNull(searchIndex)
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)
            ) {
                itemsIndexed(rows) { index, row ->
                    when (row) {
                        is ChatRow.DateDivider -> DateDividerRow(row.date)
                        is ChatRow.Turn -> HistoryBubble(row.turn, isCurrentMatch = index == currentMatchRow)
                    }
                }
            }
        }
    }

    if (showStartPicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = startDate.toEpochMillisUtc())
        DatePickerDialog(
            onDismissRequest = { showStartPicker = false },
            confirmButton = {
                Button(onClick = {
                    state.selectedDateMillis?.let { startDate = it.toLocalDateUtc() }
                    showStartPicker = false
                }) { Text("확인") }
            },
            dismissButton = { Button(onClick = { showStartPicker = false }) { Text("취소") } }
        ) {
            DatePicker(state = state)
        }
    }

    if (showEndPicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = endDate.toEpochMillisUtc())
        DatePickerDialog(
            onDismissRequest = { showEndPicker = false },
            confirmButton = {
                Button(onClick = {
                    state.selectedDateMillis?.let { endDate = it.toLocalDateUtc() }
                    showEndPicker = false
                }) { Text("확인") }
            },
            dismissButton = { Button(onClick = { showEndPicker = false }) { Text("취소") } }
        ) {
            DatePicker(state = state)
        }
    }
}

private sealed class ChatRow {
    data class DateDivider(val date: String) : ChatRow()
    data class Turn(val turn: HistoryTurn) : ChatRow()
}

// Turns already arrive in chronological order from the server - just needs a
// divider inserted whenever the calendar date changes, same as the desktop
// history window's render().
private fun buildChatRows(turns: List<HistoryTurn>): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    var lastDate = ""
    for (turn in turns) {
        val key = dateKeyLocal(turn.timestamp)
        if (key != lastDate) {
            lastDate = key
            rows.add(ChatRow.DateDivider(key))
        }
        rows.add(ChatRow.Turn(turn))
    }
    return rows
}

@Composable
private fun DateDividerRow(date: String) {
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            date,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(vertical = 6.dp)
        )
    }
}

// Mirrors ChatLogDrawer.kt's MessageBubble (same colors/shape) with two
// additions this screen needs that the live chat log doesn't: a timestamp per
// bubble, and distinguishing a 📷 gallery attachment from a 👁 desktop
// screen-view capture (the live log only ever shows a photo count).
@Composable
private fun HistoryBubble(turn: HistoryTurn, isCurrentMatch: Boolean = false) {
    val isUser = turn.role == "user"
    val deviceIcon = if (turn.source == "desktop") "💻" else "📱"
    val attachBadge = when {
        turn.hasPhotoAttachment -> " 📷"
        turn.hasScreenView -> " 👁"
        else -> ""
    }
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Surface(
            color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer,
            contentColor = if (isUser) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
            shape = MaterialTheme.shapes.medium,
            modifier = if (isCurrentMatch) {
                Modifier.border(2.dp, MaterialTheme.colorScheme.error, MaterialTheme.shapes.medium)
            } else {
                Modifier
            }
        ) {
            Column(modifier = Modifier.padding(10.dp)) {
                Text("$deviceIcon ${turn.text}$attachBadge")
                Text(
                    timeLabelLocal(turn.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }
    }
}
