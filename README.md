# 分K趨勢練習器 離線包

這個資料夾是靜態離線版，不需要 Python server。

建議使用方式：
1. 先把整個資料夾放到一個靜態網站空間，例如 GitHub Pages、Netlify、Cloudflare Pages，或任何 HTTPS static hosting。
2. 用手機 Safari/Chrome 開啟網址。
3. 加到主畫面。
4. 第一次載入過的前端與資料會被快取，之後可離線使用。

注意：
- 直接用手機 Files 開 `index.html` 可能會因瀏覽器 file:// 限制而讀不到資料。
- 教練功能需要網路。
- OpenAI API Key 只存在該裝置的 localStorage，請勿分享已設定過 key 的瀏覽器資料或打包後的個人裝置備份。
