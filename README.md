# Archive Button

Press a physical button to archive old S3 files. A buzzer confirms the result:
**1 beep** = success, **2 beeps** = partial, **1 long tone** = failed. Nothing is deleted; files move to Glacier.

```
archive-button/
├── index.html           The website (open this)
├── style.css            Styling
├── script.js            Demo logic: press, archive, buzzer, dashboard
├── lambda/
│   ├── archive_handler.py   Real archive job for AWS Lambda (Python + boto3)
│   └── iam-policy.json      Least-privilege policy for the Lambda role
└── device/main.py       ESP32 (MicroPython) firmware for the real button + buzzer
```

## 1. Run the website in VS Code

It is a plain HTML/CSS/JS site. There is nothing to install.

**Option A (simplest):** open the folder in VS Code, right-click `index.html` in the Explorer and choose **Reveal in File Explorer**, then double-click it to open it in your browser.

**Option B (recommended):** install the **Live Server** extension (by Ritwick Dey) in VS Code, right-click `index.html` and choose **Open with Live Server**. The page reloads when you save a file.

Use it:
- Click **Press Archive Button**. The three stages (Press, Archive, Buzzer) light up in turn and the buzzer plays. Turn your sound on.
- Use **Next outcome** to force a success (1 beep), partial (2 beeps) or failed (long tone) run.
- Tick **Simulate device offline** to see the offline alert.
- Every run is added to the history table with its P1/P2/P3 severity, and the stat cards and success gauge update. **Reset Demo Data** restores the starting figures.

All figures come from an in-browser simulation. Refreshing the page resets them.

## 2. Make it real on AWS

Flow: **ESP32 → AWS IoT Core (MQTT) → Lambda → S3/Glacier → result back to the device**.

1. **S3**: use a test bucket with some old objects.
2. **DynamoDB**: create table `archive-button-runs`, partition key `runId` (String).
3. **SNS**: create topic `archive-button-alerts` and subscribe your email.
4. **Lambda**: create a Python 3.12 function from `lambda/archive_handler.py`, handler `archive_handler.lambda_handler`, timeout 5 minutes. Attach the policy in `lambda/iam-policy.json` (replace `YOUR_BUCKET`). Set environment variables `BUCKET`, `AGE_LIMIT_DAYS`, `TABLE_NAME=archive-button-runs`, `ALERT_TOPIC_ARN`.
5. **IoT Core**: create a Thing, certificate and policy allowing `iot:Connect`, `iot:Publish`, `iot:Subscribe`, `iot:Receive` on `archive-button/*`. Then add a **Rule** with SQL
   `SELECT * FROM 'archive-button/+/press'` and the action *Lambda → your function*.
6. **Device**: flash MicroPython on an ESP32, create `secrets.py`, copy the certificates into `certs/`, and upload `device/main.py`. Wire the button to GPIO 4 and the buzzer to GPIO 5.
7. **Monitoring**: add CloudWatch alarms on Lambda `Errors` and on a missing heartbeat (IoT rule on `archive-button/+/heartbeat`), and keep CloudTrail on for the audit log.

To show real data on the website, add a small API (for example API Gateway + Lambda reading DynamoDB) and have `script.js` fetch the runs from it instead of using `initialRuns`. The run item fields match the dashboard: `time`, `status`, `filesMoved`, `bytesMoved`, `errors`. The dashboard can also be built in Grafana on the same table, as in the proposal.

## Notes
- Severity rules in the demo: partial run = P1, permission error or repeated failure = P2, single failure = P3. Adjust `finishRun` in `script.js` to match your support agreement.
- `copy_object` handles objects up to 5 GB. Larger ones are reported as skipped; switch to a multipart copy for those.
- Test on a test bucket first. Moving objects to Glacier has retrieval delays and early-deletion/minimum-duration charges.
