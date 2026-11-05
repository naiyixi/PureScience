# 常见问题

> 返回 [README](../README.md)

### **Q: What should I do the first time I open PureScience?**

A: Complete the five setup steps: **Environment**, **Agent runtime**, **Model provider**, **Notebook runtime**, and **Data location**. Fix required rows marked `Action needed`, install or repair the selected agent if offered, and test the model connection. Notebook setup and a custom data location are optional.

### **Q: What is an API Key, and where do I get one?**

A: An API Key is a secret credential issued by a model provider. Create or copy one from that provider's developer/API console. The provider may bill requests made with the key. Treat it like a password: never share it or commit it to a repository.

### **Q: Do I need an API Key?**

A: Not if you reuse an existing subscription login — a Claude subscription through shared browser login or an isolated app-managed `claude setup-token` flow, or a ChatGPT/Codex subscription login on the Codex backend. Built-in cloud providers and custom gateways require their own keys.

### **Q: Which model providers can I use?**

A: Open the provider picker during setup or under `Settings → Model` for the choices supported by your installed app and selected agent backend. You can use a built-in cloud provider, a compatible Custom Gateway, a Claude subscription through shared or isolated login, or a Codex subscription on the Codex backend.

### **Q: Why does the model connection test fail?**

A: Check the API Key for missing characters or spaces, verify the Base URL and region, use the provider's exact model ID, and confirm network access and account balance. For a Claude subscription, retry the shared browser login or refresh the isolated `claude setup-token` credential, depending on the selected mode.

### **Q: Why is `Continue` disabled during setup?**

A: The current step has not met its required condition. Fix any environment row marked `Action needed`, install or repair the selected agent runtime, or validate the model provider, depending on the active step. Notebook setup is optional and only affects Notebook execution.

### **Q: Setup is complete. How do I start a research task?**

A: Create or open a project, start a session, attach any source files, and describe the goal, constraints, expected output, and validation criteria. Use `@` to reference a project file and `/` to select an enabled skill.

### **Q: How do I run jobs on a remote HPC cluster?**

A: Enable the **Remote Compute (SSH)** skill under **Settings → Skills**, register your cluster under **Settings → Compute**, then start a session and select the skill with `/remote-compute-ssh`. The skill handles host registration, short commands via SSH, and fully async job submission — the app automatically starts an analysis turn when the job finishes, so you never write a polling loop.

### **Q: Is there a command-line interface?**

A: Yes. Install it in one click from **Settings → General → Command line tool → Install command** (adds `purescience` to your PATH; no separate Node.js needed). The CLI controls the local service and submits research tasks without opening a browser.

If you want the same CLI, and the Node SDK beside it, without installing the desktop app's command line tool, the package is also on npm — `npm i -g purescience` (Needs Node ≥ 22.5. It talks to the app over the local service, so the app still has to be running):

```bash
npm i -g purescience
purescience doctor     # what this machine actually has: config root, service state, app binary, signature
```
