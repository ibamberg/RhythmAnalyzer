const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

export function bindTapInput({ element, onTap, onVisualHit }) {
  const handlePointerDown = (event) => {
    event.preventDefault();
    onTap();
    onVisualHit();
  };

  const handleKeyDown = (event) => {
    if (event.code !== "Space") {
      return;
    }
    // Не перехватываем пробел, пока пользователь печатает в поле ввода
    if (FORM_TAGS.has(document.activeElement?.tagName)) {
      return;
    }
    event.preventDefault();
    onTap();
    onVisualHit();
  };

  element.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    element.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
  };
}
