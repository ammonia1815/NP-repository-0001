package com.npcompanion.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

private val CATEGORY_LABELS = listOf(
    "work" to "근무",
    "diet" to "식단",
    "exercise" to "운동",
    "sleep" to "수면"
)

private fun LocalDate.toEpochMillisUtc(): Long = atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
private fun Long.toLocalDateUtc(): LocalDate = Instant.ofEpochMilli(this).atZone(ZoneOffset.UTC).toLocalDate()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HealthRecordsScreen(prefs: Prefs, onBack: () -> Unit) {
    val client = remember(prefs.baseUrl, prefs.token) { NpApiClient(prefs.baseUrl, prefs.token) }
    val scope = rememberCoroutineScope()

    var startDate by remember { mutableStateOf(LocalDate.now().minusDays(6)) }
    var endDate by remember { mutableStateOf(LocalDate.now()) }
    var showStartPicker by remember { mutableStateOf(false) }
    var showEndPicker by remember { mutableStateOf(false) }
    var selectedCategories by remember { mutableStateOf(setOf("work", "diet", "exercise", "sleep")) }
    // On (default) interleaves every entry for a date into one single
    // chronological timeline. Off instead groups each date's entries
    // 식단 → 운동 → 수면, each internally time-ordered.
    var sortByTime by remember { mutableStateOf(true) }
    // Which 식단/운동 rows (keyed by their own timestamp, unique per entry) are
    // currently expanded to show the full raw description - collapsed by
    // default so each row is one line (식단: time · 종류 · 평가 · kcal,
    // 운동: time · 종류 · kcal).
    var expandedLogTimestamps by remember { mutableStateOf(setOf<Long>()) }

    var result by remember { mutableStateOf<HealthRecordsResponse?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    // maxRangeDays comes from the server's own response once we have one (the
    // authoritative value), but a query needs an initial client-side limit
    // before that first response exists - 30 matches what the server enforces.
    val maxRangeDays = result?.maxRangeDays ?: 30
    val rangeDays = ChronoUnit.DAYS.between(startDate, endDate) + 1
    val rangeValid = rangeDays in 1..maxRangeDays.toLong()

    fun fetch() {
        if (!rangeValid || selectedCategories.isEmpty()) return
        scope.launch {
            isLoading = true
            errorText = null
            when (val r = client.getHealthRecords(startDate.toString(), endDate.toString(), selectedCategories)) {
                is ApiResult.Success -> result = r.data
                is ApiResult.HttpError -> errorText = if (r.code == 401) "인증 실패. 설정에서 토큰을 확인해주세요." else r.message
                is ApiResult.NetworkError -> errorText = "서버에 연결할 수 없어요."
            }
            isLoading = false
        }
    }

    LaunchedEffect(Unit) { fetch() }

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
                "건강관리",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 8.dp)
            )
        }
        HorizontalDivider()

        // Bottom padding deliberately smaller than top (0dp vs 6dp) - unlike
        // ChatHistoryScreen's reference layout, whose last row ends in a
        // 48dp-tall OutlinedTextField that supplies its own visual weight at
        // the bottom edge, this screen's last row is just FilterChips, which
        // sit shorter - a symmetric 6dp/6dp here left a visibly bigger gap
        // before the divider below.
        Column(modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 0.dp)) {
            // Matches ChatHistoryScreen's "이전 대화 검색" date row exactly -
            // dateButtonPadding is wider but less tall than compactPadding to
            // offset bodyMedium's taller line height than bodySmall, netting
            // a visibly bigger date button without actually growing in height.
            val compactPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)
            val dateButtonPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    onClick = { showStartPicker = true },
                    contentPadding = dateButtonPadding
                ) { Text(startDate.toString(), style = MaterialTheme.typography.bodyMedium) }
                Text(" ~ ", modifier = Modifier.padding(horizontal = 2.dp))
                OutlinedButton(
                    onClick = { showEndPicker = true },
                    contentPadding = dateButtonPadding
                ) { Text(endDate.toString(), style = MaterialTheme.typography.bodyMedium) }
                Spacer(modifier = Modifier.weight(1f))
                Button(
                    onClick = { fetch() },
                    enabled = rangeValid && selectedCategories.isNotEmpty() && !isLoading,
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

            Row(
                modifier = Modifier.padding(top = 6.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                CATEGORY_LABELS.forEach { (key, label) ->
                    FilterChip(
                        selected = key in selectedCategories,
                        onClick = {
                            selectedCategories = if (key in selectedCategories) {
                                selectedCategories - key
                            } else {
                                selectedCategories + key
                            }
                        },
                        label = { Text(label) }
                    )
                }
                FilterChip(
                    selected = sortByTime,
                    onClick = { sortByTime = !sortByTime },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.Sort, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    label = { Text(if (sortByTime) "시간순" else "항목순") }
                )
            }

            errorText?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
            }
        }

        HorizontalDivider()

        if (isLoading && result == null) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(24.dp),
                horizontalArrangement = Arrangement.Center
            ) {
                CircularProgressIndicator()
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                result?.let { r ->
                    val groups = buildDayGroups(r, selectedCategories, sortByTime)
                    if (groups.isEmpty()) {
                        item {
                            Text(
                                "선택한 기간/항목에 해당하는 기록이 없어요.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp)
                            )
                        }
                    } else {
                        itemsIndexed(groups) { index, group ->
                            DayGroupBlock(
                                group = group,
                                isEvenRow = index % 2 == 0,
                                expandedLogTimestamps = expandedLogTimestamps,
                                onToggleLogExpanded = { ts ->
                                    expandedLogTimestamps = if (ts in expandedLogTimestamps) {
                                        expandedLogTimestamps - ts
                                    } else {
                                        expandedLogTimestamps + ts
                                    }
                                }
                            )
                        }
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

// One calendar date's worth of records across whichever categories are
// currently selected - this is what lets the screen render "날짜 단위로
//합쳐서" instead of four separate always-vertically-stacked sections.
private data class DayGroup(
    val date: String,
    val work: WorkRecord?,
    val logs: List<TaggedLog>,
    val dietKcal: Double,
    val dietAlcohol: Double,
    val hasDiet: Boolean,
    val exerciseKcal: Double,
    val exerciseCount: Int,
    val hasExercise: Boolean,
    val sleepHours: Double,
    val hasSleep: Boolean
)

// Union of every date that has a record in any selected category, sorted
// chronologically (ISO YYYY-MM-DD strings already sort correctly as plain
// strings, so no date parsing is needed just to order them).
private data class TaggedLog(val category: String, val item: HealthLogRecord)

private fun buildDayGroups(result: HealthRecordsResponse, categories: Set<String>, sortByTime: Boolean): List<DayGroup> {
    val dates = sortedSetOf<String>()
    if ("work" in categories) result.work.forEach { dates += it.date }
    if ("diet" in categories) result.diet.forEach { dates += it.date }
    if ("exercise" in categories) result.exercise.forEach { dates += it.date }
    if ("sleep" in categories) result.sleep.forEach { dates += it.date }

    return dates.map { date ->
        val diet = if ("diet" in categories) result.diet.filter { it.date == date } else emptyList()
        val exercise = if ("exercise" in categories) result.exercise.filter { it.date == date } else emptyList()
        val sleep = if ("sleep" in categories) result.sleep.filter { it.date == date } else emptyList()

        // Off: grouped 식단 → 운동 → 수면 (each internally time-ordered).
        // On: every entry for the date interleaved into one timeline.
        val logs = if (sortByTime) {
            (diet.map { TaggedLog("식단", it) } + exercise.map { TaggedLog("운동", it) } + sleep.map { TaggedLog("수면", it) })
                .sortedBy { it.item.sortKey }
        } else {
            diet.sortedBy { it.sortKey }.map { TaggedLog("식단", it) } +
                exercise.sortedBy { it.sortKey }.map { TaggedLog("운동", it) } +
                sleep.sortedBy { it.sortKey }.map { TaggedLog("수면", it) }
        }

        DayGroup(
            date = date,
            work = if ("work" in categories) result.work.find { it.date == date } else null,
            logs = logs,
            dietKcal = diet.sumOf { it.calories ?: 0.0 },
            dietAlcohol = diet.sumOf { it.alcoholG ?: 0.0 },
            hasDiet = diet.isNotEmpty(),
            exerciseKcal = exercise.sumOf { it.calories ?: 0.0 },
            exerciseCount = exercise.size,
            hasExercise = exercise.isNotEmpty(),
            sleepHours = sleep.sumOf { it.sleepHours ?: 0.0 },
            hasSleep = sleep.isNotEmpty()
        )
    }
}

// Trims a trailing ".0" so whole-number totals ("8시간", not "8.0시간") read
// naturally, while fractional ones ("4.3시간") keep one decimal place.
private fun formatTotal(value: Double): String {
    val rounded = Math.round(value * 10) / 10.0
    return if (rounded == rounded.toLong().toDouble()) rounded.toLong().toString() else rounded.toString()
}

// NpTheme's darkColorScheme() only overrides primary/background/surface -
// surfaceVariant is left at Material3's generic default (a grayish-purple
// with no relation to this app's navy palette), so using it here would have
// shown a mismatched, barely-related tint instead of a real alternating
// stripe. A color explicitly derived from the app's own navy background
// guarantees a visible, on-palette difference instead.
private val DayStripeColor = Color(0xFF18292C)

@Composable
private fun DayGroupBlock(
    group: DayGroup,
    isEvenRow: Boolean,
    expandedLogTimestamps: Set<Long>,
    onToggleLogExpanded: (Long) -> Unit
) {
    // A deliberate (not default-theme) alternating tint so dates stay easy to
    // tell apart while scrolling without competing with the category tags.
    val stripeColor = if (isEvenRow) MaterialTheme.colorScheme.background else DayStripeColor

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(stripeColor)
            .padding(horizontal = 16.dp, vertical = 10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(group.date, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            group.work?.let {
                Text(
                    "  ${it.code} (${it.hourRange})",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        group.logs.forEach { tagged ->
            DayLogLine(
                category = tagged.category,
                item = tagged.item,
                expanded = tagged.item.timestamp in expandedLogTimestamps,
                onToggleExpanded = { onToggleLogExpanded(tagged.item.timestamp) }
            )
        }

        val totalLines = buildList {
            if (group.hasDiet) {
                val alcoholPart = if (group.dietAlcohol > 0) ", 알코올 ${formatTotal(group.dietAlcohol)}g" else ""
                add("총 식단 약 ${formatTotal(group.dietKcal)}kcal$alcoholPart")
            }
            if (group.hasExercise) {
                add("총 운동 약 ${formatTotal(group.exerciseKcal)}kcal (${group.exerciseCount}건)")
            }
            if (group.hasSleep) {
                add("총 수면 ${formatTotal(group.sleepHours)}시간")
            }
        }
        if (totalLines.isNotEmpty()) {
            Text(
                totalLines.joinToString("  ·  "),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 4.dp)
            )
        }
    }
    HorizontalDivider()
}

// No divider per line here - lines within one date are meant to read as a
// single flowing block; DayGroupBlock's own trailing divider is what
// separates one date from the next.
@Composable
private fun DayLogLine(
    category: String,
    item: HealthLogRecord,
    expanded: Boolean,
    onToggleExpanded: () -> Unit
) {
    // 수면 is a single line ("[수면] 23:30~07:00 · 총 7.5시간") - the time the
    // user happened to report it (hours after waking) was never meaningful
    // the way it is for diet/exercise, so it's dropped entirely for this
    // category rather than shown alongside the actual sleep range.
    if (category == "수면") {
        Text(
            "[$category] ${item.text}${item.detail?.let { " · $it" } ?: ""}",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
        )
        return
    }

    // 식단/운동 둘 다 한 줄(식단: 시간·종류·평가·칼로리, 운동: 시간·종류·칼로리)로
    // 접혀 있고, 탭하면 원문 설명이 펼쳐진다 - 원문을 항상 보여주면 하루치 목록이
    // 너무 길어지는 걸 막기 위함.
    if (category == "식단") {
        val kcalText = item.calories?.let { "${it.toInt()}kcal" } ?: "-"
        ExpandableLogLine(
            category = category,
            headline = "${item.time} · ${item.mealType ?: "미분류"} · ${item.assessment ?: "X"} · $kcalText",
            detailText = item.text,
            expanded = expanded,
            onToggleExpanded = onToggleExpanded
        )
        return
    }

    if (category == "운동") {
        val kcalText = item.calories?.let { "${it.toInt()}kcal" } ?: "-"
        ExpandableLogLine(
            category = category,
            headline = "${item.time} · ${item.exerciseType ?: "종류 미상"} · $kcalText",
            detailText = item.text,
            expanded = expanded,
            onToggleExpanded = onToggleExpanded
        )
        return
    }
}

@Composable
private fun ExpandableLogLine(
    category: String,
    headline: String,
    detailText: String,
    expanded: Boolean,
    onToggleExpanded: () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClick = onToggleExpanded),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "[$category] $headline",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = if (expanded) "접기" else "펼치기",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp)
            )
        }
        if (expanded) {
            Text(
                detailText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp)
            )
        }
    }
}
