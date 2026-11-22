<?php
// Recomputes `raw` and `signature` of momo-sample.json with the string concatenation of MoMo's
// official PHP samples (github.com/momo-wallet/payment, read 22/11/2026), copied field for field:
//   create: php/PayMoMo/init_payment.php   result (IPN, redirect): php/PayMoMo/ipn_momo.php
//   query:  php/atm/query_transaction.php
// Not run by the test suite; run it by hand when the fixture changes (from the repo root, Git Bash):
//   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/apps/api/src/modules/payment/momo/testing:/f:ro" \
//     php:8.4-cli-alpine php /f/momo-reference.php
// Prints one line per case: `same` when the fixture holds what the sample computes, and the
// computed values as JSON (to paste) when it does not.
$fixture = json_decode(file_get_contents(__DIR__ . '/momo-sample.json'), true);
$accessKey = $fixture['credentials']['accessKey'];
$secretKey = $fixture['credentials']['secretKey'];
$ok = true;
foreach ($fixture['cases'] as $name => $case) {
    extract($case['fields']);
    switch ($case['message']) {
        case 'create':
            $rawHash = "accessKey=" . $accessKey . "&amount=" . $amount . "&extraData=" . $extraData . "&ipnUrl=" . $ipnUrl . "&orderId=" . $orderId . "&orderInfo=" . $orderInfo . "&partnerCode=" . $partnerCode . "&redirectUrl=" . $redirectUrl . "&requestId=" . $requestId . "&requestType=" . $requestType;
            break;
        case 'result':
            $rawHash = "accessKey=" . $accessKey . "&amount=" . $amount . "&extraData=" . $extraData . "&message=" . $message . "&orderId=" . $orderId . "&orderInfo=" . $orderInfo . "&orderType=" . $orderType . "&partnerCode=" . $partnerCode . "&payType=" . $payType . "&requestId=" . $requestId . "&responseTime=" . $responseTime . "&resultCode=" . $resultCode . "&transId=" . $transId;
            break;
        case 'query':
            $rawHash = "accessKey=" . $accessKey . "&orderId=" . $orderId . "&partnerCode=" . $partnerCode . "&requestId=" . $requestId;
            break;
    }
    $signature = hash_hmac("sha256", $rawHash, $secretKey);
    $same = $rawHash === $case['raw'] && $signature === $case['signature'];
    $ok = $ok && $same;
    echo ($same ? 'same' : 'DIFFERENT'), "  $name  ", json_encode(['raw' => $rawHash, 'signature' => $signature], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
}
exit($ok ? 0 : 1);
