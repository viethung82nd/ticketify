// Preloaded into a worker process by scenario-d.int-spec (`node -r <this> main.worker.js`).
//
// Makes every email hang inside the `send-email` job, AFTER the PDF was uploaded and BEFORE SMTP
// is asked for anything: the exact moment scenario D kills the worker at. Nothing in src/ knows
// about it.
//
//   STALL_MAILER_MODULE   absolute path of the compiled smtp-mailer.js
//   STALL_MAILER_SECONDS  how long each send hangs before going through
'use strict';

const target = process.env.STALL_MAILER_MODULE;
const seconds = Number(process.env.STALL_MAILER_SECONDS);
if (!target || !(seconds > 0)) {
  throw new Error('STALL_MAILER_MODULE and STALL_MAILER_SECONDS are required');
}

const mailer = require(target);
const realSend = mailer.SmtpMailer.prototype.send;
mailer.SmtpMailer.prototype.send = async function stallingSend(message) {
  // The line the test waits for before it kills this process.
  console.log(`STALL mailer: holding the message to ${message.to} for ${seconds}s`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return realSend.call(this, message);
};
