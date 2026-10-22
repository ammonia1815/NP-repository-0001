import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config";
import { Assistant, AssistantImage, AssistantReply, AssistantStateHint, ConversationSession, REPLY_SCHEMA } from "./assistant-types";
import { buildContextPrefix } from "./memory";
import { TurnSource } from "./state";
import { listFiles, readFileSafe, readFilesSafe, writeRecordFile } from "./files";
import { fetchPageText } from "./localSearch";
import { recallOriginalConversation, MemoryCandidate } from "./longterm";
import {
  addRotationRule,
  appendHealthLog,
  correctPastShift,
  deleteHealthLog,
  queryHealthLogs,
  setShiftOverride,
  setShiftOverrideRange,
  updateHealthLog,
  updateTargets,
} from "./health";

const FILE_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description:
      "허용된 조회 폴더('엔피 조회 가능 자료') 안의 파일/폴더 목록을 봅니다. path를 생략하면 최상위 폴더를 봅니다. 이 폴더 밖은 절대 볼 수 없습니다. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "조회할 하위 경로 (생략 시 최상위 폴더)" } },
    },
  },
  {
    name: "read_file",
    description:
      "허용된 조회 폴더 안의 파일 하나를 읽습니다. 텍스트 파일은 내용을 그대로, 이미지 파일은 이미지를 직접 봅니다. 읽기 전용이며 파일을 만들거나 수정, 삭제하는 기능은 없습니다. 파일을 2개 이상 읽어야 한다면 이걸 여러 번 부르지 말고 read_files를 한 번만 사용하세요. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "읽을 파일의 경로 (조회 폴더 기준 상대경로)" } },
      required: ["path"],
    },
  },
  {
    name: "read_files",
    description:
      "허용된 조회 폴더 안의 여러 파일(예: 사진 여러 장)을 한 번에 읽습니다. 사진 여러 장을 한꺼번에 분석해야 할 때처럼, 파일을 2개 이상 읽어야 하면 read_file을 반복 호출하지 말고 이걸 한 번만 사용하세요 - 매번 따로 부르면 그만큼 응답이 느려집니다. 사용자가 파일이나 사진을 봐달라고 명확히 요청했을 때만 호출하고, 무관한 일상 대화·코딩·창작·게임 등에서는 애매해도 절대 호출하지 마세요.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "읽을 파일들의 경로 목록 (조회 폴더 기준 상대경로)",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "write_record_file",
    description:
      "조회 폴더 안의 '엔피_기록.md' 파일 하나에만 내용을 기록합니다. 다른 어떤 파일에도 쓸 수 없습니다. 사용자가 중요한 대화 내용·일정·코드 등을 '기록해줘/적어줘'처럼 명시적으로 요청했을 때만 호출하세요 - 애매하거나 요청하지 않았으면 절대 호출하지 마세요. '주인_메모.md'는 사용자가 직접 작성하는 별도 파일이라 이 도구로 절대 건드릴 수 없습니다(그 파일은 read_file로 읽기만 가능).",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "기록할 내용" },
        mode: {
          type: "string",
          enum: ["append", "overwrite"],
          description: "append=기존 기록 뒤에 이어서 추가(기본값, 보통 이걸 사용), overwrite=파일 전체를 이 내용으로 교체(사용자가 명확히 '전부 지우고 다시' 같은 요청을 했을 때만)",
        },
      },
      required: ["content"],
    },
  },
];

const HEALTH_TOOLS: Anthropic.Tool[] = [
  {
    name: "register_shift_rule",
    description:
      "사용자의 교대근무 로테이션 규칙을 새로 등록합니다. 기존에 진행 중이던 규칙은 자동으로 이 규칙 시작일 전날까지로 마감됩니다. 근무 패턴 자체가 바뀔 때(대략 3개월에 한 번 정도) 사용하세요 - 하루 대근/휴가는 register_shift_rule이 아니라 set_shift_override를 사용하세요.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "근무 코드 반복 패턴, 예: NNNXXDDXAAAX (N=야간,D=주간,A=오후,X=휴무)" },
        anchor_date: { type: "string", description: "패턴의 첫 글자가 적용되는 기준일, YYYY-MM-DD" },
        effective_from: { type: "string", description: "이 규칙이 적용되기 시작하는 날짜, YYYY-MM-DD (과거로 소급하지 말 것)" },
      },
      required: ["pattern", "anchor_date", "effective_from"],
    },
  },
  {
    name: "set_shift_override",
    description: "특정 날짜 하루의 근무를 대근/휴가 등으로 규칙과 다르게 예외 처리합니다. 이틀 이상 연속된 기간이면 이것을 여러 번 부르지 말고 set_shift_override_range를 한 번만 사용하세요.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        code: { type: "string", description: "실제 적용된 근무 코드, 예: DA" },
        reason: { type: "string", description: "사유, 예: 대근" },
      },
      required: ["date", "code"],
    },
  },
  {
    name: "set_shift_override_range",
    description: "여러 날짜에 걸친 연속된 기간(예: 여행/장기 휴가) 전체를 같은 코드로 한 번에 예외 처리합니다. 하루짜리면 set_shift_override를 대신 사용하세요.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD (포함)" },
        code: { type: "string", description: "이 기간 전체에 적용할 근무 코드, 예: X" },
        reason: { type: "string", description: "사유, 예: 휴가" },
      },
      required: ["start_date", "end_date", "code"],
    },
  },
  {
    name: "correct_past_shift",
    description: "이미 확정된 과거 날짜의 근무 기록을 뒤늦게 정정합니다 (근무 규칙 자체는 건드리지 않음).",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, 오늘 또는 과거 날짜만 가능" },
        code: { type: "string" },
      },
      required: ["date", "code"],
    },
  },
  {
    name: "log_health_entry",
    description:
      "사용자가 언급한 식사/음주/수면/운동을 새로 기록하거나, 기존 기록 하나를 수정합니다. timestamp를 비우면 새 기록을 생성하고, timestamp를 채우면 해당 id의 기존 기록을 수정합니다(채운 필드만 바뀌고 나머지는 그대로 유지됨). 수정 시 정확한 id가 필요하므로, 이번 대화에서 방금 기록한 게 아니라면 먼저 query_health_history로 조회해서 '(id:...)' 값을 확인하세요. 어떤 기록을 말하는지 애매하면(여러 후보가 있거나 특정이 안 되면) 수정하지 말고 사용자에게 먼저 확인하세요. 칼로리와 순수 알코올량(g)은 당신이 직접 추정해서 입력하세요.",
    input_schema: {
      type: "object",
      properties: {
        timestamp: {
          type: "number",
          description: "수정할 기존 기록의 id (query_health_history 결과의 id 값). 새로 기록하는 경우 생략하세요.",
        },
        date: {
          type: "string",
          description: "YYYY-MM-DD. 새로 기록할 때 생략하면 오늘 날짜. 기존 기록 수정 시 날짜 자체를 바꾸려면 채우고, 안 바꾸려면 생략.",
        },
        raw_text: {
          type: "string",
          description: "사용자가 말한 내용 요약. 새로 기록할 때는 반드시 채우세요. 기존 기록을 수정할 때는 내용을 바꾸는 경우에만 채우고, 안 바꾸려면 생략하세요.",
        },
        alcohol_g: { type: "number", description: "추정 순수 알코올량(g), 없으면 0" },
        calories_est: {
          type: "number",
          description:
            "추정 칼로리(kcal). 식사든 운동이든 열량이 관련된 내용이 하나라도 언급되면 항상 채우세요 - 정확히 알기 어려운 운동(예: 푸쉬업, 스쿼트)이라도 대략치를 추정해서 적고, 절대 비워두지 마세요.",
        },
        meal_type: {
          type: "string",
          enum: ["집밥", "외식", "간편식", "급식", "반주", "간식", "음료", "음주", "기타"],
          description:
            "식단/음주 기록일 때만 채우세요. 집밥=재료를 직접 가열·조리함(밀키트를 끓이거나 볶는 것 포함), 간편식=이미 다 조리된 것을 그대로 먹음(배달, 편의점/마트 완제품, 로티세리 치킨 등 - 데우기만 한 것도 포함), 외식=식당에서 먹음, 급식=회사/기관 급식, 반주=식사에 곁들인 가벼운 음주, 음주=식사 없이 술만, 간식=가벼운 주전부리, 음료=물 외의 마실 것. 사용자의 교대근무 특성상 '아침/점심/저녁/야식' 같은 시간대 구분은 의미 없으니 사용하지 마세요 - 시간은 이미 별도로 기록됩니다.",
        },
        assessment: {
          type: "string",
          enum: ["건강식", "고지방", "고탄수", "과식", "폭식", "X"],
          description:
            "식단 품질/양에 대한 당신의 평가. 단순 음료나 소량 간식처럼 평가가 무의미하면 X. 술이 포함된 기록이라면 이 값은 서버가 그날 누적량 기준으로 자동 계산/덮어쓰므로 비워두거나 X로 두세요.",
        },
        sleep_start: {
          type: "string",
          description:
            "수면 시작(취침) 시각, HH:MM 24시간제. 수면이 언급됐다면 반드시 sleep_end와 함께 채우세요 - 총 수면시간은 이 둘로 자동 계산되니 직접 계산하지 마세요.",
        },
        sleep_end: {
          type: "string",
          description: "수면 종료(기상) 시각, HH:MM 24시간제. sleep_start와 반드시 함께 채우세요.",
        },
        event_time: {
          type: "string",
          description:
            "이 사건이 실제로 일어난 시각, HH:MM 24시간제. 지금 막 일어난 일을 실시간으로 기록할 때는 생략하세요(기록 시각이 곧 실제 시각이므로). 하지만 과거에 있었던 일을 나중에 소급해서 입력할 때는(예: 사용자가 '어제 출근길에 걸었는데 깜빡하고 기록을 안 했어'처럼 말할 때) 반드시 채우세요 - 비워두면 화면에 지금 입력하는 시각이 실제 발생 시각인 것처럼 잘못 표시됩니다. 수면 기록은 sleep_start가 이미 실제 시각 역할을 하므로 보통 생략해도 됩니다.",
        },
        exercise: { type: "boolean", description: "운동/스트레칭 여부" },
        exercise_type: {
          type: "string",
          enum: ["aerobic", "anaerobic", "mixed"],
          description:
            "exercise가 true일 때만 채우세요. aerobic=유산소(조깅/걷기/계단오르기 등 지속적 심박 상승 운동), anaerobic=무산소(푸쉬업/스쿼트/웨이트 등 근력 위주 운동), mixed=둘 다 섞인 경우.",
        },
      },
    },
  },
  {
    name: "update_health_targets",
    description: "수면/음주 등 목표치를 수정합니다.",
    input_schema: {
      type: "object",
      properties: {
        sleep_hours_min: { type: "number" },
        weekly_alcohol_limit_g: { type: "number" },
      },
    },
  },
  {
    name: "query_health_history",
    description:
      "지정한 기간의 식사/음주/수면/운동 기록을 날짜·근무코드와 함께 조회합니다. 매 대화에 자동으로 보이는 최근 3건만으로 충분하면 호출하지 마세요 - 그보다 더 과거이거나, 특정 기간의 집계·평균·패턴(예: '이번 주 평균 음주량', '지난달 수면 패턴')을 물었을 때만 호출하세요.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "조회 시작일, YYYY-MM-DD" },
        end_date: { type: "string", description: "조회 종료일(포함), YYYY-MM-DD" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "delete_health_entry",
    description:
      "식단/음주/수면/운동 기록 하나를 삭제합니다. 정확한 id가 필요합니다 - 이번 대화에서 방금 log_health_entry로 기록한 게 아니라면 먼저 query_health_history로 조회해서 '(id:...)' 값을 확인한 뒤 호출하세요. 어떤 기록을 말하는지 애매하면(여러 후보가 있거나 특정이 안 되면) 삭제하지 말고 사용자에게 먼저 확인하세요.",
    input_schema: {
      type: "object",
      properties: {
        timestamp: { type: "number", description: "삭제할 기록의 id (query_health_history 결과의 id 값)" },
      },
      required: ["timestamp"],
    },
  },
];

const RECALL_MEMORY_TOOL: Anthropic.Tool = {
  name: "recall_original_conversation",
  description:
    "[예전 대화에서 기억하는 내용] 블록에 뜬 요약 기억 중 하나가 너무 짧게 요약되어 있어서 더 자세한 원본 대화가 필요할 때, 그 번호를 골라 원본 대화 전후 턴을 직접 확인합니다. 모든 기억에 다 쓸 필요는 없고, 사용자가 그 기억에 대해 더 자세히 물어보거나 디테일이 중요한 경우에만 사용하세요.",
  input_schema: {
    type: "object",
    properties: {
      index: { type: "integer", description: "[예전 대화에서 기억하는 내용] 목록에서의 번호 (1부터 시작)" },
    },
    required: ["index"],
  },
};

// Anthropic's own web_search tool (like Gemini's google_search) runs from a
// datacenter IP and gets blocked by sites that specifically target crawlers
// (confirmed for real against m.dcinside.com: a server-side request got
// nothing, but a plain fetch from this app - running on the user's own home
// network - returned the full page). This fetches a URL the user already
// gave directly, from here, sidestepping that block entirely. Takes a
// free-text url (unlike recall_original_conversation's index-based design)
// because the URL comes from the conversation itself, not something the
// model has to invent from a search snippet.
const FETCH_WEBPAGE_TOOL: Anthropic.Tool = {
  name: "fetch_webpage",
  description:
    "사용자가 보낸 특정 URL의 페이지 내용을 이 프로그램이 직접 접속해서 읽어옵니다. 구글 검색으로는 크롤링이 차단되어 못 읽는 페이지(디시인사이드 등 커뮤니티 사이트 포함)도 이 도구로는 읽을 수 있습니다. 사용자가 직접 링크를 보냈을 때 사용하세요.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "읽어올 페이지의 전체 URL" },
      query: { type: "string", description: "페이지가 너무 길 때 어느 부분을 찾아야 하는지 - 찾는 내용/키워드 (선택)" },
    },
    required: ["url"],
  },
};

const ALL_TOOLS: Anthropic.Tool[] = [...FILE_TOOLS, ...HEALTH_TOOLS, RECALL_MEMORY_TOOL, FETCH_WEBPAGE_TOOL];
const CLIENT_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Mirrors gemini.ts's logTokenUsage - this side had NO visibility at all
// until now (confirmed the gap while chasing a real cost discrepancy: a
// user-observed AI Studio deduction didn't match the Gemini-only estimate,
// and this file turned out to have zero usage logging to rule Claude in or
// out). cache_creation_input_tokens is what Anthropic bills at writing a new
// cache entry (pricier than a plain read); cache_read_input_tokens is the
// discounted repeat-read.
function logClaudeTokenUsage(label: string, usage: Anthropic.Usage | undefined): void {
  if (!usage) {
    console.log(`[usage-claude] ${label}: (no usage data returned)`);
    return;
  }
  console.log(
    `[usage-claude] ${label}: input=${usage.input_tokens}, cache_write=${usage.cache_creation_input_tokens ?? 0}, cache_read=${usage.cache_read_input_tokens ?? 0}, output=${usage.output_tokens}`
  );
}

async function executeTool(block: Anthropic.ToolUseBlock, memoryCandidates: MemoryCandidate[]): Promise<Anthropic.ToolResultBlockParam> {
  try {
    if (block.name === "fetch_webpage") {
      const input = block.input as { url?: string; query?: string };
      if (!input.url) {
        return { type: "tool_result", tool_use_id: block.id, content: "url이 비어 있습니다.", is_error: true };
      }
      try {
        const text = await fetchPageText(input.url, input.query);
        return { type: "tool_result", tool_use_id: block.id, content: text };
      } catch (err) {
        return { type: "tool_result", tool_use_id: block.id, content: `페이지를 읽지 못했습니다: ${String(err)}`, is_error: true };
      }
    }

    if (block.name === "recall_original_conversation") {
      const input = block.input as { index?: number };
      const index = typeof input.index === "number" ? input.index : -1;
      const candidate = memoryCandidates[index - 1];
      if (!candidate) {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "해당 번호의 기억을 찾을 수 없습니다. [예전 대화에서 기억하는 내용] 목록의 번호를 다시 확인하세요.",
        };
      }
      if (!candidate.id) {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "이건 요약된 기억이 아니라 최근 대화 원문이라, 더 불러올 원본이 따로 없습니다.",
        };
      }
      return { type: "tool_result", tool_use_id: block.id, content: recallOriginalConversation(candidate.id) };
    }

    if (block.name === "list_files") {
      const input = block.input as { path?: string };
      const entries = listFiles(input.path ?? ".");
      const text =
        entries.length === 0
          ? "(빈 폴더입니다)"
          : entries.map((e) => `${e.isDirectory ? "[폴더] " : ""}${e.name}`).join("\n");
      return { type: "tool_result", tool_use_id: block.id, content: text };
    }

    if (block.name === "read_file") {
      const input = block.input as { path: string };
      const result = readFileSafe(input.path);
      if (result.kind === "text") {
        return { type: "tool_result", tool_use_id: block.id, content: result.text };
      }
      if (result.kind === "image") {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: result.mediaType as "image/png", data: result.data },
            },
          ],
        };
      }
      return { type: "tool_result", tool_use_id: block.id, content: result.message, is_error: true };
    }

    if (block.name === "read_files") {
      const input = block.input as { paths: string[] };
      const files = readFilesSafe(input.paths);
      const content: Anthropic.ToolResultBlockParam["content"] = [];
      for (const { path: p, result } of files) {
        if (result.kind === "text") {
          (content as Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>).push({
            type: "text",
            text: `=== ${p} ===\n${result.text}`,
          });
        } else if (result.kind === "image") {
          (content as Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>).push(
            { type: "text", text: `=== ${p} ===` },
            { type: "image", source: { type: "base64", media_type: result.mediaType as "image/png", data: result.data } }
          );
        } else {
          (content as Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>).push({
            type: "text",
            text: `=== ${p} === (읽기 실패: ${result.message})`,
          });
        }
      }
      return { type: "tool_result", tool_use_id: block.id, content };
    }

    if (block.name === "write_record_file") {
      const input = block.input as { content: string; mode?: "append" | "overwrite" };
      const result = writeRecordFile(input.content, input.mode ?? "append");
      return { type: "tool_result", tool_use_id: block.id, content: result.message, is_error: !result.ok };
    }

    if (block.name === "register_shift_rule") {
      const input = block.input as { pattern: string; anchor_date: string; effective_from: string };
      addRotationRule(input.pattern, input.anchor_date, input.effective_from);
      return { type: "tool_result", tool_use_id: block.id, content: "근무 규칙이 등록되었습니다." };
    }

    if (block.name === "set_shift_override") {
      const input = block.input as { date: string; code: string; reason?: string };
      setShiftOverride(input.date, input.code, input.reason);
      return { type: "tool_result", tool_use_id: block.id, content: "예외 근무가 기록되었습니다." };
    }

    if (block.name === "set_shift_override_range") {
      const input = block.input as { start_date: string; end_date: string; code: string; reason?: string };
      setShiftOverrideRange(input.start_date, input.end_date, input.code, input.reason);
      return { type: "tool_result", tool_use_id: block.id, content: "기간 전체가 예외 근무로 기록되었습니다." };
    }

    if (block.name === "correct_past_shift") {
      const input = block.input as { date: string; code: string };
      correctPastShift(input.date, input.code);
      return { type: "tool_result", tool_use_id: block.id, content: "과거 근무 기록이 정정되었습니다." };
    }

    if (block.name === "log_health_entry") {
      const input = block.input as {
        timestamp?: number;
        date?: string;
        raw_text?: string;
        alcohol_g?: number;
        calories_est?: number;
        meal_type?: "집밥" | "외식" | "간편식" | "급식" | "반주" | "간식" | "음료" | "음주" | "기타";
        assessment?: "건강식" | "고지방" | "고탄수" | "과식" | "폭식" | "X";
        sleep_start?: string;
        sleep_end?: string;
        event_time?: string;
        exercise?: boolean;
        exercise_type?: "aerobic" | "anaerobic" | "mixed";
      };
      if (input.timestamp !== undefined) {
        const { timestamp, ...patch } = input;
        const ok = updateHealthLog(timestamp, patch);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: ok ? "수정되었습니다." : "해당 id의 기록을 찾을 수 없습니다.",
        };
      }
      const { timestamp: _unused, ...rest } = input;
      appendHealthLog({ date: input.date ?? todayStr(), ...rest, raw_text: input.raw_text ?? "" });
      return { type: "tool_result", tool_use_id: block.id, content: "기록되었습니다." };
    }

    if (block.name === "update_health_targets") {
      const input = block.input as { sleep_hours_min?: number; weekly_alcohol_limit_g?: number };
      updateTargets(input);
      return { type: "tool_result", tool_use_id: block.id, content: "목표치가 수정되었습니다." };
    }

    if (block.name === "query_health_history") {
      const input = block.input as { start_date: string; end_date: string };
      const entries = queryHealthLogs(input.start_date, input.end_date);
      const text =
        entries.length === 0
          ? "해당 기간에 기록된 데이터가 없습니다."
          : entries.map((e) => `${e.date} [근무:${e.shiftCode ?? "?"}] (id:${e.timestamp}): ${e.summary}`).join("\n");
      return { type: "tool_result", tool_use_id: block.id, content: text };
    }

    if (block.name === "delete_health_entry") {
      const input = block.input as { timestamp: number };
      const ok = deleteHealthLog(input.timestamp);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: ok ? "삭제되었습니다." : "해당 id의 기록을 찾을 수 없습니다.",
      };
    }

    return { type: "tool_result", tool_use_id: block.id, content: "알 수 없는 도구입니다.", is_error: true };
  } catch (err) {
    return { type: "tool_result", tool_use_id: block.id, content: String(err), is_error: true };
  }
}

const MAX_TOOL_ITERATIONS = 5;

export class ClaudeAssistant implements Assistant {
  private client: Anthropic | null;
  private config = loadConfig();

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  isReady(): boolean {
    return this.client !== null;
  }

  private async callModel(messages: Anthropic.MessageParam[]) {
    return this.client!.messages.create({
      model: this.config.model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: this.config.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }, ...ALL_TOOLS],
      output_config: {
        effort: this.config.effort,
        format: {
          type: "json_schema",
          schema: REPLY_SCHEMA,
        },
      },
      messages,
    });
  }

  // onStateHint is part of the shared Assistant interface (Gemini uses it to
  // report real-time web-search activity via streaming), but isn't
  // implemented for Claude yet - accepted and simply unused so callers don't
  // need to special-case which provider is active.
  async send(
    userText: string,
    session: ConversationSession,
    idleGapMs: number,
    source: TurnSource,
    images?: AssistantImage[],
    _onStateHint?: (state: AssistantStateHint) => void
  ): Promise<AssistantReply> {
    if (!this.client) {
      return {
        reply:
          "아직 Claude API 키가 설정되지 않았어요. .env 파일에 ANTHROPIC_API_KEY를 넣고 앱을 다시 시작해주세요.",
        emotion: "sad",
      };
    }

    const { prefix, memoryCandidates } = await buildContextPrefix(
      userText,
      session.turns,
      session.startedAt,
      idleGapMs,
      source,
      "claude"
    );
    const content = prefix ? `${prefix}\n\n[새 메시지]\n${userText}` : userText;
    session.turns.push({ role: "user", text: userText, timestamp: Date.now() });

    const userContent: Anthropic.MessageParam["content"] =
      images && images.length > 0
        ? [
            ...images.map(
              (img): Anthropic.ImageBlockParam => ({
                type: "image",
                source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
              })
            ),
            { type: "text", text: content },
          ]
        : content;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

    try {
      let response = await this.callModel(messages);
      logClaudeTokenUsage("initial call", response.usage);

      let iterations = 0;
      while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && CLIENT_TOOL_NAMES.has(b.name)
        );
        if (toolUseBlocks.length === 0) break;

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: await Promise.all(toolUseBlocks.map((b) => executeTool(b, memoryCandidates))) });

        response = await this.callModel(messages);
        logClaudeTokenUsage(`follow-up call ${iterations}`, response.usage);
      }

      const textBlocks = response.content.filter((b) => b.type === "text");
      const lastText = textBlocks[textBlocks.length - 1];
      const raw = lastText && "text" in lastText ? lastText.text : "{}";
      const parsed = JSON.parse(raw) as AssistantReply;
      // See the matching check in gemini.ts: JSON.parse("{}") doesn't throw,
      // so a blank/malformed reply would otherwise silently pass through as a
      // "successful" turn and get saved as literally undefined.
      if (!parsed.reply) {
        console.error("Claude returned an empty/malformed reply:", raw);
        return { reply: "미안해요, 지금 대답하는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.", emotion: "sad" };
      }

      session.turns.push({ role: "assistant", text: parsed.reply, timestamp: Date.now() });

      return parsed;
    } catch (err) {
      console.error("Claude API error:", err);
      return {
        reply: "미안해요, 지금 대답하는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.",
        emotion: "sad",
      };
    }
  }
}
