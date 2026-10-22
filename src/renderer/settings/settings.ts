interface Window {
  settingsAPI: {
    getScale: () => Promise<number>;
    setScale: (scale: number) => void;
    onScaleChanged: (callback: (scale: number) => void) => void;
    getServerInfo: () => Promise<{ localUrl: string; token: string }>;
    copyToClipboard: (text: string) => void;
  };
}

const slider = document.getElementById("scale-slider") as HTMLInputElement;
const label = document.getElementById("scale-label") as HTMLSpanElement;

function setSliderDisplay(percent: number): void {
  slider.value = String(percent);
  label.textContent = `${percent}%`;
}

// "input" fires continuously while dragging (unlike "change", which only
// fires on release) so the avatar resizes live as the handle is dragged.
slider.addEventListener("input", () => {
  const percent = Number(slider.value);
  label.textContent = `${percent}%`;
  window.settingsAPI.setScale(percent / 100);
});

// Keeps the slider in sync if the scale changes from elsewhere (mouse wheel
// on the avatar, or the tray menu's step buttons).
window.settingsAPI.onScaleChanged((scale) => {
  setSliderDisplay(Math.round(scale * 100));
});

window.settingsAPI.getScale().then((scale) => {
  setSliderDisplay(Math.round(scale * 100));
});

const serverUrlInput = document.getElementById("server-url") as HTMLInputElement;
const serverTokenInput = document.getElementById("server-token") as HTMLInputElement;

window.settingsAPI.getServerInfo().then(({ localUrl, token }) => {
  serverUrlInput.value = localUrl;
  serverTokenInput.value = token;
});

document.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.copyTarget;
    if (!targetId) return;
    const input = document.getElementById(targetId) as HTMLInputElement | null;
    if (!input) return;
    window.settingsAPI.copyToClipboard(input.value);

    // Brief visual confirmation since there's no other feedback for a
    // clipboard write - reverts on its own rather than needing a second click.
    btn.textContent = "복사됨";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "복사";
      btn.classList.remove("copied");
    }, 1200);
  });
});
