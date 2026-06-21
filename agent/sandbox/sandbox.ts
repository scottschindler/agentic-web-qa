import { defineSandbox, type SandboxBackend } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { vercel } from "eve/sandbox/vercel";

const hostedOnVercel = Boolean(process.env.VERCEL);
const backend: SandboxBackend = hostedOnVercel
  ? vercel({
      runtime: "node24",
      resources: {
        vcpus: 2,
      },
    })
  : justbash();

export default defineSandbox({
  backend,
});
