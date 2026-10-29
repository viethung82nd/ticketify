<?php
// Recomputes `reference.cases` of vnpay-sample.json with the signing loop of the VNPay PHP sample
// (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), copied unchanged. Not run by the
// test suite; run it by hand when the fixture changes (from the repo root, Git Bash):
//   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/apps/api/src/modules/payment/vnpay/testing:/f:ro" \
//     php:8.4-cli-alpine php /f/vnpay-reference.php
$fixture = json_decode(file_get_contents(__DIR__ . '/vnpay-sample.json'), true);
$vnp_HashSecret = $fixture['reference']['hashSecret'];
$ok = true;
foreach ($fixture['reference']['cases'] as $name => $case) {
    $inputData = $case['params'];
    ksort($inputData);
    $i = 0;
    $hashdata = "";
    foreach ($inputData as $key => $value) {
        if ($i == 1) {
            $hashdata .= '&' . urlencode($key) . "=" . urlencode($value);
        } else {
            $hashdata .= urlencode($key) . "=" . urlencode($value);
            $i = 1;
        }
    }
    $vnpSecureHash = hash_hmac('sha512', $hashdata, $vnp_HashSecret);
    $same = $hashdata === $case['hashData'] && $vnpSecureHash === $case['secureHash'];
    $ok = $ok && $same;
    echo ($same ? 'same' : 'DIFFERENT'), "  $name  $vnpSecureHash\n";
}
exit($ok ? 0 : 1);
