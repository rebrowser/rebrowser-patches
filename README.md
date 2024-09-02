# 🪄 Patches for undetectable browser automation

This repo contains patches to enhance popular web automation libraries. Specifically, it targets the [`puppeteer`](https://github.com/puppeteer/puppeteer) and [`playwright`](https://github.com/microsoft/playwright) packages.

Some aspects of automation libraries or browser behavior cannot be adjusted through settings or command-line switches. Therefore, we fix these issues by patching the library's source code. While this approach is fragile and may break as the libraries' source code changes over time, the goal is to maintain this repo with community help to keep the patches up to date.

## Available patches
### Fix `Runtime.Enable` leak
Popular automation libraries rely on the CDP command `Runtime.Enable`, which allows receiving events from the `Runtime.` domain. This is crucial for managing execution contexts used to evaluate JavaScript on pages, a key feature for any automation process.

However, there's a technique that detects the usage of this command, revealing that the browser is controlled by automation software like Puppeteer or Playwright. This technique is **used by all major anti-bot software** such as Cloudflare, DataDome, and others.

> We've prepared a full article about our investigation on this leak, which you can read in [our blog](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries-61740).

For more details on this technique, read DataDome's blog post: [How New Headless Chrome & the CDP Signal Are Impacting Bot Detection](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/).
In brief, it's a few lines of JavaScript on the page that are automatically called if `Runtime.Enable` was used.

Our fix disables the automatic `Runtime.Enable` command on every frame. Instead, we manually create contexts with unknown IDs when a frame is created. Then, when code needs to be executed, we have implemented two approaches to get the context ID. You can choose which one to use.

#### 1. Create a new isolated context via `Page.createIsolatedWorld` and save its ID from the CDP response.
🟢 Pros: All your code will be executed in a separate isolated world, preventing page scripts from detecting your changes via MutationObserver. For more details, see the [execution-monitor test](https://github.com/prescience-data/prescience-data.github.io/blob/master/execution-monitor.html#L32).

🔴 Cons: You won't be able to access main context variables and code. While this is necessary for some use cases, the isolated context generally works fine for most scenarios. Also, web workers don't allow creating new worlds, so you can't execute your code inside a worker. This is a niche use case but may matter in some situations.

#### 2. Call `Runtime.Enable` and then immediately call `Runtime.Disable`. 
This triggers `Runtime.executionContextCreated` events, allowing us to catch the proper context ID.

🟢 Pros: You will have full access to the main context.

🔴 Cons: There's a slight chance that during this short timeframe, the page will call code that leads to the leak. The risk is low, as detection code is usually called during specific actions like CAPTCHA pages or login/registration forms, typically right after the page loads. Your business logic is usually called a bit later.

> 🎉 Our tests show that both approaches are currently undetectable by Cloudflare or DataDome.

**Important:** After applying the patch, you need to enable it by setting `REBROWSER_PATCHES_RUNTIME_FIX_MODE` environment variable. This allows you to easily switch between patched and non-patched versions based on your business logic.

- `REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated` &mdash; always run all scripts in isolated context
- `REBROWSER_PATCHES_RUNTIME_FIX_MODE=enableDisable` &mdash; use Enable/Disable technique
- `REBROWSER_PATCHES_DEBUG=1` &mdash; enable some debugging messages

Remember, you can set these variables in different ways, for example, in code:
```js
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = "alwaysIsolated"
```
or in command line:
```shell
REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated node app.js
```

> To test this leak, you can use this page: [https://kaliiiiiiiiii.github.io/brotector/](https://kaliiiiiiiiii.github.io/brotector/) ([sources](https://github.com/kaliiiiiiiiii/brotector/blob/master/brotector.js))

| Before patch 👎 | After patch 👍 |
|--------| --- |
| ![before](https://github.com/user-attachments/assets/daf4fee7-538c-49aa-946a-f9e939fe8fe5) | ![after](https://github.com/user-attachments/assets/0680a6f1-2fd9-4a49-ad7f-ae32758715ec) |

## Usage
This package is designed to be run against an installed library. Install the Puppeteer library, then call the patcher, and it's ready to go.

In the root folder of your project, run:
```
npx rebrowser-patches@latest patch
```

You can easily revert all changes with this command:
```
npx rebrowser-patches@latest unpatch
```

You can also patch a package by providing the full path to its folder, for example:

```
npx rebrowser-patches@latest patch --packagePath /web/app/node_modules/puppeteer-core-custom
```

You can see all command-line options by running `npx rebrowser-patches@latest --help`, but currently, there's just one patch for one library, so you don't need to configure anything.

⚠️ Be aware that after running `npm install` or `yarn install` in your project folder, it might override all the changes from the patches. You'll need to run the patcher again to keep the patches in place.

## How to update the patches?
If you already have your package patched and want to update to the latest version of rebrowser-patches, the easiest way would be to delete `node_modules/puppeteer-core`, then run `npm install`, and then run `npx rebrowser-patches@latest patch`.

## Supported versions

| Pptr Ver                             | Release Date | Chrome Ver | Patch Support |
|--------------------------------------|--------------|------------|---------------|
| 23.2.x                               | 2024-08-29   | 128        | ✅             |
| 23.1.x                               | 2024-08-14   | 127        | ✅             |
| 23.0.x                               | 2024-08-07   | 127        | ✅             |
| 22.15.x                              | 2024-07-31   | 127        | ✅             |
| 22.14.x                              | 2024-07-25   | 127        | ✅             |
| 22.13.x                              | 2024-07-11   | 126        | ✅             |
| 22.12.x<br/><small>and below</small> | 2024-06-21   | 126        | ❌             |

## What about Playwright support?
Currently, this repo contains only a patch for the latest Puppeteer version. Creating these patches is time-consuming as it requires digging into someone else's code and changing it in ways it wasn't designed for.

📣 If we see **demand from the community** for Playwright support, we'll be happy to allocate more resources to this mission. Please provide your feedback in the [issues section](https://github.com/rebrowser/rebrowser-patches/issues).

## Follow the project
We're currently developing more patches to improve web automation transparency, which will be released in this repo soon. Please support the project by clicking ⭐️ star or watch button.

💭 If you have any ideas, thoughts, or questions, feel free to reach out to our team by [email](mailto:info@rebrowser.net) or use the [issues section](https://github.com/rebrowser/rebrowser-patches/issues).

## The fix doesn't help, I'm still getting blocked 🤯
⚠️ It's important to know that this fix alone won't make your browser bulletproof and undetectable. You need to address **many other aspects** such as proxies, proper user-agent and fingerprints (canvas, WebGL), and more.

Always keep in mind: the less you manipulate browser internals via JS injections, the better. There are ways to detect that internal objects such as console, navigator, and others were affected by Proxy objects or Object.defineProperty. It's tricky, but it's always a cat-and-mouse game.

If you've tried everything and still face issues, try asking a question in the issues section or consider using cloud solutions from Rebrowser.

## What is Rebrowser?
This package is sponsored and maintained by [Rebrowser](https://rebrowser.net). We allow you to scale your automation in the cloud with hundreds of unique fingerprints.

Our cloud browsers have great success rates and come with nice features such as notifications if your library uses `Runtime.Enable` during execution or has other red flags that could be improved. [Create an account](https://rebrowser.net) today to get invited to test our bleeding-edge platform and take your automation business to the next level.


## Patch command on Windows
When you try to run this patcher on a Windows machine, you will probably encounter an error because the patch command is not found. To fix this, you need to install [Git](https://git-scm.com/download/win), which includes patch.exe. After you have installed it, you need to add it to your PATH:

```
set PATH=%PATH%;C:\Program Files\Git\usr\bin\
```

You can check that patch.exe is installed correctly by using next command:
```
patch -v
```

### Disclaimer
<small>
No responsibility is accepted for the use of this software. This software is intended for educational and informational purposes only. Users should use this software at their own risk. The developers of the software cannot be held liable for any damages that may result from the use of this software. This software is not intended to bypass any security measures, including but not limited to CAPTCHAs, anti-bot systems, or other protective mechanisms employed by websites. The software must not be used for malicious purposes. By using this software, you agree to this disclaimer and acknowledge that you are using the software responsibly and in compliance with all applicable laws and regulations.</small>
