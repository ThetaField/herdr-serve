export function apiTokenGuide() {
  return `创建 Cloudflare API Token（API 令牌）
1. 打开 https://dash.cloudflare.com/profile/api-tokens
   入口：My Profile（我的个人资料）→ API Tokens → Create Token（创建令牌）。
2. 选择 Create Custom Token（创建自定义令牌）→ Get started；名称填 Herdr Serve。
3. 添加三行 Permissions（权限）：
   Account（账户） | Cloudflare Tunnel | Edit（编辑）
   Zone（区域）    | DNS               | Edit（编辑）
   Zone（区域）    | Zone              | Read（读取）
   如果账户权限列表显示 Cloudflare One Connector: cloudflared，可选择它的 Edit 权限代替 Cloudflare Tunnel。
4. Account Resources：Include → Specific account → 你的域名所属账户。
   Zone Resources：Include → Specific zone → 你要使用的域名，例如 example.com。
   Zone 在这里指域名。只需选择名称，不用查找或填写 ID。
5. Continue to summary → Create Token。复制生成的令牌字符串（只显示一次）。
   这里使用 API Token；Global API Key、Tunnel token 和 Herdr 登录 token 都不适用。
6. 在另一个终端保存令牌。执行：
   mkdir -p ~/.config/herdr-serve
   touch ~/.config/herdr-serve/cloudflare-api-token
   chmod 600 ~/.config/herdr-serve/cloudflare-api-token
   nano ~/.config/herdr-serve/cloudflare-api-token
   在编辑器中粘贴令牌，文件只保留这一行。Ctrl+O、Enter 保存，Ctrl+X 退出。
   然后执行：
   realpath ~/.config/herdr-serve/cloudflare-api-token
7. 回到 Setup，输入上面输出的完整文件路径。此处填写路径，不是令牌字符串。
   插件会读取令牌并列出可选域名。不要把令牌发到聊天中。
官方说明：https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
`;
}
