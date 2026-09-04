export async function openSoftwareKeyboard(page, { offsetTop = 0 } = {}) {
  const current = page.viewportSize() ?? { width: 390, height: 844 };
  const nextHeight = Math.max(320, Math.floor(current.height * 0.6));

  return page.evaluate(
    ({ height, offsetTop }) => {
      const vv = window.visualViewport;
      if (!vv) throw new Error('window.visualViewport is not supported in this environment');

      try {
        Object.defineProperty(vv, 'height', { configurable: true, get: () => height });
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => offsetTop });
      } catch {
        return false;
      }

      vv.dispatchEvent(new Event('resize'));
      return true;
    },
    { height: nextHeight, offsetTop },
  );
}

export async function closeSoftwareKeyboard(page) {
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (!vv) throw new Error('window.visualViewport is not supported in this environment');

    delete vv.height;
    delete vv.offsetTop;

    vv.dispatchEvent(new Event('resize'));
  });
}
