// The instructions and inputs the hardware oracle runs. Shared by scripts/simd-oracle.ts, which
// executes them on a real AArch64 core and writes the fixture, and a64simd.oracle.test.ts,
// which runs the same words through the emitter and compares. Every instruction reads and
// writes only v0-v3, x2-x5 (w2-w5) and NZCV: that is what the native stub loads and stores.

export const CASES = 16;
/** 64 bytes v0-v3, 32 bytes x2-x5, 8 bytes NZCV (bits 31:28) */
export const INPUT_BYTES = 104;

export const INSTRUCTIONS = `
fadd s0, s1, s2|fadd d0, d1, d2|fsub s0, s1, s2|fsub d0, d1, d2|fmul s0, s1, s2|fmul d0, d1, d2|fdiv s0, s1, s2|fdiv d0, d1, d2
fmax s0, s1, s2|fmin d0, d1, d2|fmaxnm s0, s1, s2|fminnm d0, d1, d2|fnmul s0, s1, s2|fmadd s0, s1, s2, s3|fmsub d0, d1, d2, d3|fnmadd s0, s1, s2, s3|fnmsub d0, d1, d2, d3
fabs s0, s1|fneg d0, d1|fsqrt s0, s1|fsqrt d0, d1|fcvt d0, s1|fcvt s0, d1|fcvt h0, s1|fcvt s0, h1|fcvt h0, d1|fcvt d0, h1
frintn s0, s1|frintp d0, d1|frintm s0, s1|frintz d0, d1|frinta s0, s1|frintx d0, d1|frinti s0, s1|frintn d0, d1|frinta d0, d1
fcmp s0, s1|fcmp d0, d1|fcmp s0, #0.0|fcmpe d0, d1|fccmp s0, s1, #5, ge|fccmp d0, d1, #10, lt|fcsel s0, s1, s2, gt|fcsel d0, d1, d2, ne
fmov s0, w2|fmov d0, x2|fmov w2, s1|fmov x2, d1|fmov v0.d[1], x2|fmov x2, v1.d[1]|fmov s0, #3.0|fmov d0, #-1.5|fmov s0, s1|fmov d0, d1
scvtf s0, w2|ucvtf s0, w2|scvtf d0, x2|ucvtf d0, x2|scvtf s0, x2|ucvtf d0, w2|scvtf d0, w2|ucvtf s0, x2
fcvtzs w2, s1|fcvtzu w2, s1|fcvtzs x2, d1|fcvtzu x2, d1|fcvtns w2, s1|fcvtnu w2, d1|fcvtps w2, s1|fcvtms x2, d1|fcvtas w2, s1|fcvtau x2, d1|fcvtzs w2, d1|fcvtzs x2, s1|fcvtms w2, s1|fcvtps x2, d1|fcvtnu x2, s1
fcvtzs w2, s1, #5|fcvtzu x2, d1, #3|scvtf s0, w2, #4|ucvtf d0, x2, #7|scvtf d0, x2, #12|fcvtzs x2, s1, #9
scvtf s0, s1|ucvtf d0, d1|scvtf d0, d1|ucvtf s0, s1|fcvtzs s0, s1|fcvtzu d0, d1|fcvtns s0, s1|fcvtas d0, d1|fcvtms d0, d1|fcvtpu s0, s1|fcvtzs s0, s1, #4|fcvtzu d0, d1, #11|scvtf s0, s1, #3|ucvtf d0, d1, #6
frecpe s0, s1|frsqrte d0, d1|frecpe d0, d1|frsqrte s0, s1|frecps s0, s1, s2|frsqrts d0, d1, d2|fmulx s0, s1, s2|fmulx d0, d1, d2|frecpx s0, s1|frecpx d0, d1
fcmeq s0, s1, s2|fcmgt d0, d1, d2|fcmge s0, s1, s2|facge d0, d1, d2|facgt s0, s1, s2|fcmeq s0, s1, #0.0|fcmlt d0, d1, #0.0|fcmgt s0, s1, #0.0|fcmle d0, d1, #0.0|fcmge s0, s1, #0.0|fabd s0, s1, s2|fabd d0, d1, d2
faddp s0, v1.2s|faddp d0, v1.2d|fmaxp s0, v1.2s|fminnmp d0, v1.2d|fmaxnmp s0, v1.2s|fminp d0, v1.2d|fmaxv s0, v1.4s|fminv s0, v1.4s|fmaxnmv s0, v1.4s|fminnmv s0, v1.4s
fadd v0.4s, v1.4s, v2.4s|fadd v0.2d, v1.2d, v2.2d|fadd v0.2s, v1.2s, v2.2s|fsub v0.4s, v1.4s, v2.4s|fsub v0.2d, v1.2d, v2.2d|fmul v0.4s, v1.4s, v2.4s|fmul v0.2d, v1.2d, v2.2d|fmul v0.2s, v1.2s, v2.2s|fdiv v0.4s, v1.4s, v2.4s|fdiv v0.2d, v1.2d, v2.2d
fmax v0.4s, v1.4s, v2.4s|fmin v0.2d, v1.2d, v2.2d|fmaxnm v0.4s, v1.4s, v2.4s|fminnm v0.2s, v1.2s, v2.2s|fmla v0.4s, v1.4s, v2.4s|fmls v0.2d, v1.2d, v2.2d|fmla v0.2s, v1.2s, v2.2s|fabd v0.4s, v1.4s, v2.4s|fmulx v0.4s, v1.4s, v2.4s
fneg v0.4s, v1.4s|fabs v0.2d, v1.2d|fsqrt v0.4s, v1.4s|fsqrt v0.2d, v1.2d|frintn v0.4s, v1.4s|frintm v0.2d, v1.2d|frintz v0.2s, v1.2s|frinta v0.4s, v1.4s|frintx v0.2d, v1.2d|frinti v0.4s, v1.4s|frintp v0.4s, v1.4s
fcmeq v0.4s, v1.4s, v2.4s|fcmgt v0.2d, v1.2d, v2.2d|fcmge v0.4s, v1.4s, v2.4s|facge v0.4s, v1.4s, v2.4s|facgt v0.2d, v1.2d, v2.2d|fcmeq v0.4s, v1.4s, #0.0|fcmgt v0.2d, v1.2d, #0.0|fcmge v0.4s, v1.4s, #0.0|fcmle v0.2s, v1.2s, #0.0|fcmlt v0.4s, v1.4s, #0.0
faddp v0.4s, v1.4s, v2.4s|fmaxp v0.2s, v1.2s, v2.2s|fminp v0.4s, v1.4s, v2.4s|fmaxnmp v0.2d, v1.2d, v2.2d|fminnmp v0.4s, v1.4s, v2.4s|faddp v0.2d, v1.2d, v2.2d
frecpe v0.4s, v1.4s|frsqrte v0.2d, v1.2d|frecps v0.4s, v1.4s, v2.4s|frsqrts v0.2d, v1.2d, v2.2d|frecpe v0.2s, v1.2s
scvtf v0.4s, v1.4s|ucvtf v0.2d, v1.2d|scvtf v0.2s, v1.2s|scvtf v0.2d, v1.2d|ucvtf v0.4s, v1.4s|fcvtzs v0.4s, v1.4s|fcvtzu v0.2d, v1.2d|fcvtns v0.4s, v1.4s|fcvtms v0.2d, v1.2d|fcvtps v0.2s, v1.2s|fcvtas v0.4s, v1.4s|fcvtnu v0.2d, v1.2d|fcvtau v0.4s, v1.4s|fcvtzs v0.2s, v1.2s|fcvtzu v0.4s, v1.4s
fcvtl v0.2d, v1.2s|fcvtl2 v0.2d, v1.4s|fcvtl v0.4s, v1.4h|fcvtl2 v0.4s, v1.8h|fcvtn v0.2s, v1.2d|fcvtn2 v0.4s, v1.2d|fcvtn v0.4h, v1.4s|fcvtn2 v0.8h, v1.4s
scvtf v0.4s, v1.4s, #4|ucvtf v0.2d, v1.2d, #10|fcvtzs v0.4s, v1.4s, #3|fcvtzu v0.2d, v1.2d, #20|fcvtzs v0.2s, v1.2s, #32|fcvtzu v0.4s, v1.4s, #1|scvtf v0.2s, v1.2s, #7
fmul v0.4s, v1.4s, v2.s[3]|fmul v0.2d, v1.2d, v2.d[1]|fmul v0.2s, v1.2s, v2.s[2]|fmla v0.4s, v1.4s, v2.s[1]|fmls v0.2d, v1.2d, v2.d[0]|fmulx v0.4s, v1.4s, v2.s[0]|fmul s0, s1, v2.s[2]|fmla d0, d1, v2.d[1]|fmls s0, s1, v2.s[3]
fmov v0.4s, #0.75|fmov v0.2d, #-2.0|fmov v0.2s, #0.25
add v0.4s, v1.4s, v2.4s|add v0.16b, v1.16b, v2.16b|add v0.8h, v1.8h, v2.8h|add v0.2d, v1.2d, v2.2d|add v0.8b, v1.8b, v2.8b|add v0.4h, v1.4h, v2.4h|add v0.2s, v1.2s, v2.2s
sub v0.4s, v1.4s, v2.4s|sub v0.2d, v1.2d, v2.2d|sub v0.16b, v1.16b, v2.16b|mul v0.4s, v1.4s, v2.4s|mul v0.8h, v1.8h, v2.8h|mul v0.16b, v1.16b, v2.16b|mla v0.4s, v1.4s, v2.4s|mla v0.8h, v1.8h, v2.8h|mls v0.16b, v1.16b, v2.16b
neg v0.4s, v1.4s|neg v0.2d, v1.2d|neg v0.16b, v1.16b|abs v0.8h, v1.8h|abs v0.2d, v1.2d|abs v0.4s, v1.4s
cmeq v0.4s, v1.4s, v2.4s|cmeq v0.2d, v1.2d, v2.2d|cmeq v0.16b, v1.16b, v2.16b|cmgt v0.4s, v1.4s, v2.4s|cmgt v0.2d, v1.2d, v2.2d|cmgt v0.8h, v1.8h, v2.8h|cmge v0.16b, v1.16b, v2.16b|cmge v0.2d, v1.2d, v2.2d|cmhi v0.4s, v1.4s, v2.4s|cmhi v0.2d, v1.2d, v2.2d|cmhs v0.8h, v1.8h, v2.8h|cmhs v0.2d, v1.2d, v2.2d|cmtst v0.4s, v1.4s, v2.4s|cmtst v0.2d, v1.2d, v2.2d
cmeq v0.4s, v1.4s, #0|cmgt v0.2d, v1.2d, #0|cmge v0.16b, v1.16b, #0|cmle v0.8h, v1.8h, #0|cmlt v0.4s, v1.4s, #0|cmle v0.2d, v1.2d, #0|cmlt v0.2d, v1.2d, #0|cmge v0.2d, v1.2d, #0|cmeq v0.2d, v1.2d, #0
smax v0.4s, v1.4s, v2.4s|smax v0.16b, v1.16b, v2.16b|smin v0.8h, v1.8h, v2.8h|umax v0.4s, v1.4s, v2.4s|umax v0.16b, v1.16b, v2.16b|umin v0.8h, v1.8h, v2.8h
shadd v0.8h, v1.8h, v2.8h|uhadd v0.16b, v1.16b, v2.16b|srhadd v0.4s, v1.4s, v2.4s|urhadd v0.8h, v1.8h, v2.8h|shsub v0.16b, v1.16b, v2.16b|uhsub v0.4s, v1.4s, v2.4s
sqadd v0.4s, v1.4s, v2.4s|sqadd v0.16b, v1.16b, v2.16b|sqadd v0.8h, v1.8h, v2.8h|uqadd v0.4s, v1.4s, v2.4s|uqadd v0.16b, v1.16b, v2.16b|sqsub v0.8h, v1.8h, v2.8h|sqsub v0.4s, v1.4s, v2.4s|uqsub v0.16b, v1.16b, v2.16b|uqsub v0.4s, v1.4s, v2.4s
sshl v0.4s, v1.4s, v2.4s|sshl v0.16b, v1.16b, v2.16b|sshl v0.2d, v1.2d, v2.2d|sshl v0.8h, v1.8h, v2.8h|ushl v0.4s, v1.4s, v2.4s|ushl v0.16b, v1.16b, v2.16b|ushl v0.2d, v1.2d, v2.2d|srshl v0.4s, v1.4s, v2.4s|srshl v0.8h, v1.8h, v2.8h|urshl v0.16b, v1.16b, v2.16b|sqshl v0.4s, v1.4s, v2.4s|sqshl v0.8h, v1.8h, v2.8h|uqshl v0.16b, v1.16b, v2.16b|sqrshl v0.4s, v1.4s, v2.4s|sqrshl v0.2d, v1.2d, v2.2d|uqrshl v0.8h, v1.8h, v2.8h
sabd v0.4s, v1.4s, v2.4s|sabd v0.16b, v1.16b, v2.16b|uabd v0.8h, v1.8h, v2.8h|saba v0.4s, v1.4s, v2.4s|uaba v0.16b, v1.16b, v2.16b
addp v0.4s, v1.4s, v2.4s|addp v0.2d, v1.2d, v2.2d|addp v0.16b, v1.16b, v2.16b|smaxp v0.4s, v1.4s, v2.4s|sminp v0.8h, v1.8h, v2.8h|umaxp v0.16b, v1.16b, v2.16b|uminp v0.4s, v1.4s, v2.4s
and v0.16b, v1.16b, v2.16b|bic v0.16b, v1.16b, v2.16b|orr v0.16b, v1.16b, v2.16b|orn v0.16b, v1.16b, v2.16b|eor v0.16b, v1.16b, v2.16b|bsl v0.16b, v1.16b, v2.16b|bit v0.16b, v1.16b, v2.16b|bif v0.16b, v1.16b, v2.16b|and v0.8b, v1.8b, v2.8b|orr v0.8b, v1.8b, v2.8b|not v0.16b, v1.16b|not v0.8b, v1.8b
rev64 v0.4s, v1.4s|rev64 v0.8h, v1.8h|rev64 v0.16b, v1.16b|rev32 v0.8h, v1.8h|rev32 v0.16b, v1.16b|rev16 v0.16b, v1.16b|cnt v0.16b, v1.16b|cnt v0.8b, v1.8b|clz v0.4s, v1.4s|clz v0.8h, v1.8h|clz v0.16b, v1.16b|cls v0.4s, v1.4s|cls v0.16b, v1.16b|rbit v0.16b, v1.16b
sqabs v0.4s, v1.4s|sqabs v0.8h, v1.8h|sqneg v0.16b, v1.16b|saddlp v0.4s, v1.8h|saddlp v0.2d, v1.4s|uaddlp v0.8h, v1.16b|sadalp v0.4s, v1.8h|uadalp v0.2d, v1.4s
xtn v0.4h, v1.4s|xtn2 v0.8h, v1.4s|xtn v0.2s, v1.2d|xtn2 v0.16b, v1.8h|sqxtn v0.4h, v1.4s|sqxtn2 v0.16b, v1.8h|uqxtn v0.2s, v1.2d|sqxtun v0.8b, v1.8h|sqxtun2 v0.4s, v1.2d|uqxtn2 v0.8h, v1.4s
shll v0.8h, v1.8b, #8|shll2 v0.4s, v1.8h, #16|shll v0.2d, v1.2s, #32
addv s0, v1.4s|addv b0, v1.16b|addv h0, v1.8h|saddlv d0, v1.4s|uaddlv s0, v1.8h|saddlv h0, v1.8b|uaddlv h0, v1.16b|smaxv s0, v1.4s|sminv b0, v1.16b|umaxv h0, v1.8h|uminv s0, v1.4s|addp d0, v1.2d|addv h0, v1.4h|umaxv b0, v1.8b|sminv h0, v1.4h|smaxv b0, v1.16b
shl v0.4s, v1.4s, #3|shl v0.16b, v1.16b, #7|shl v0.2d, v1.2d, #40|shl v0.8h, v1.8h, #15|sshr v0.4s, v1.4s, #1|sshr v0.16b, v1.16b, #7|sshr v0.2d, v1.2d, #63|sshr v0.8h, v1.8h, #4|ushr v0.4s, v1.4s, #31|ushr v0.2d, v1.2d, #1|ushr v0.8b, v1.8b, #8|ushr v0.4s, v1.4s, #32
ssra v0.4s, v1.4s, #5|usra v0.2d, v1.2d, #3|srshr v0.4s, v1.4s, #4|urshr v0.8h, v1.8h, #3|srsra v0.16b, v1.16b, #2|ursra v0.4s, v1.4s, #8|sri v0.4s, v1.4s, #8|sli v0.8h, v1.8h, #4|sri v0.8b, v1.8b, #3|sli v0.2s, v1.2s, #9|sri v0.2d, v1.2d, #64|sli v0.16b, v1.16b, #0|sqshl v0.4s, v1.4s, #2|uqshl v0.8h, v1.8h, #3|sqshlu v0.16b, v1.16b, #1
sshll v0.8h, v1.8b, #3|sshll2 v0.4s, v1.8h, #0|ushll v0.2d, v1.2s, #5|ushll2 v0.8h, v1.16b, #7|sxtl v0.4s, v1.4h|uxtl2 v0.2d, v1.4s
shrn v0.8b, v1.8h, #3|shrn2 v0.8h, v1.4s, #9|rshrn v0.2s, v1.2d, #12|sqshrn v0.4h, v1.4s, #5|sqrshrn2 v0.16b, v1.8h, #2|uqshrn v0.2s, v1.2d, #7|uqrshrn v0.8b, v1.8h, #1|sqshrun v0.4h, v1.4s, #6|sqrshrun2 v0.4s, v1.2d, #20
saddl v0.8h, v1.8b, v2.8b|saddl2 v0.4s, v1.8h, v2.8h|uaddl v0.2d, v1.2s, v2.2s|saddw v0.4s, v1.4s, v2.4h|uaddw2 v0.2d, v1.2d, v2.4s|ssubl v0.8h, v1.8b, v2.8b|usubl2 v0.2d, v1.4s, v2.4s|ssubw v0.8h, v1.8h, v2.8b|usubw2 v0.4s, v1.4s, v2.8h
addhn v0.4h, v1.4s, v2.4s|addhn2 v0.16b, v1.8h, v2.8h|subhn v0.2s, v1.2d, v2.2d|raddhn v0.4h, v1.4s, v2.4s|rsubhn2 v0.8h, v1.4s, v2.4s|sabal v0.4s, v1.4h, v2.4h|uabdl v0.8h, v1.8b, v2.8b|uabdl2 v0.2d, v1.4s, v2.4s
smull v0.8h, v1.8b, v2.8b|smull2 v0.4s, v1.8h, v2.8h|umull v0.2d, v1.2s, v2.2s|umull2 v0.2d, v1.4s, v2.4s|smlal v0.4s, v1.4h, v2.4h|umlsl v0.2d, v1.2s, v2.2s|smlal2 v0.2d, v1.4s, v2.4s|pmull v0.8h, v1.8b, v2.8b
sdot v0.4s, v1.16b, v2.16b|udot v0.2s, v1.8b, v2.8b|sdot v0.4s, v1.16b, v2.4b[1]|udot v0.2s, v1.8b, v2.4b[3]
mul v0.4s, v1.4s, v2.s[2]|mul v0.8h, v1.8h, v2.h[5]|mla v0.4s, v1.4s, v2.s[0]|mls v0.4h, v1.4h, v2.h[3]|smull v0.4s, v1.4h, v2.h[2]|umull2 v0.2d, v1.4s, v2.s[1]|smlal v0.2d, v1.2s, v2.s[3]|umlsl v0.4s, v1.4h, v2.h[7]
sqdmulh v0.4s, v1.4s, v2.4s|sqrdmulh v0.8h, v1.8h, v2.8h|sqdmulh v0.4s, v1.4s, v2.s[1]|sqrdmulh v0.4h, v1.4h, v2.h[2]
dup v0.4s, w2|dup v0.16b, w2|dup v0.2d, x2|dup v0.8h, v1.h[3]|dup v0.2d, v1.d[1]|dup v0.8b, v1.b[9]|dup s0, v1.s[2]|dup d0, v1.d[1]|dup b0, v1.b[9]|dup h0, v1.h[6]
ins v0.b[3], w2|ins v0.d[0], x2|ins v0.h[5], v1.h[1]|ins v0.s[2], v1.s[3]|ins v0.d[1], v1.d[0]|umov w2, v1.b[7]|umov x2, v1.d[1]|umov w2, v1.h[2]|smov w2, v1.h[3]|smov x2, v1.s[1]|smov w2, v1.b[15]|smov x2, v1.b[0]
movi v0.4s, #0x5a, lsl #16|mvni v0.8h, #0x21|movi v0.2d, #0xff00ff00ff00ff00|movi v0.16b, #0x81|orr v0.4s, #0x42, lsl #8|bic v0.4s, #0x33|movi v0.4s, #0x99, msl #8|mvni v0.2s, #0x7, msl #16|movi d0, #0x00ff00ff00ff00ff|movi v0.8b, #0xc3
zip1 v0.4s, v1.4s, v2.4s|zip2 v0.16b, v1.16b, v2.16b|uzp1 v0.8h, v1.8h, v2.8h|uzp2 v0.2d, v1.2d, v2.2d|trn1 v0.2s, v1.2s, v2.2s|trn2 v0.8b, v1.8b, v2.8b|zip1 v0.2d, v1.2d, v2.2d|uzp1 v0.16b, v1.16b, v2.16b|trn1 v0.4s, v1.4s, v2.4s|zip2 v0.8h, v1.8h, v2.8h
ext v0.16b, v1.16b, v2.16b, #7|ext v0.8b, v1.8b, v2.8b, #5|ext v0.16b, v1.16b, v2.16b, #12|ext v0.16b, v1.16b, v1.16b, #3
tbl v0.16b, {v1.16b}, v2.16b|tbl v0.8b, {v1.16b, v2.16b}, v3.8b|tbx v0.16b, {v1.16b}, v2.16b|tbl v0.16b, {v1.16b, v2.16b, v3.16b}, v0.16b|tbx v0.8b, {v1.16b, v2.16b}, v3.8b
add d0, d1, d2|sub d0, d1, d2|cmeq d0, d1, d2|cmgt d0, d1, d2|cmhi d0, d1, d2|cmtst d0, d1, d2|cmge d0, d1, d2|cmhs d0, d1, d2|sshl d0, d1, d2|ushl d0, d1, d2|sqadd s0, s1, s2|uqsub b0, b1, b2|sqadd d0, d1, d2|uqadd h0, h1, h2|sqsub d0, d1, d2
neg d0, d1|abs d0, d1|cmeq d0, d1, #0|cmlt d0, d1, #0|cmgt d0, d1, #0|cmle d0, d1, #0|cmge d0, d1, #0|shl d0, d1, #5|sshr d0, d1, #7|ushr d0, d1, #1|ssra d0, d1, #3|usra d0, d1, #9|srshr d0, d1, #2|sri d0, d1, #10|sli d0, d1, #4
sqxtn s0, d1|uqxtn h0, s1|sqxtun b0, h1|sqshrn s0, d1, #8|uqrshrn h0, s1, #3|sqshrun b0, h1, #2|sqabs s0, s1|sqneg h0, h1|sqabs d0, d1|sqdmulh s0, s1, s2|sqrdmulh h0, h1, h2|sqshl s0, s1, #3|uqshl d0, d1, #20
`.split(/[\n|]/).map((s) => s.trim()).filter(Boolean);

/** xorshift32 over a case-specific seed: the same stream on both sides */
function prng(seed: number): () => number {
  let x = (seed * 2654435761 + 1) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}
const SPECIAL32 = [0, -0, 1, -1, 0.5, 2, Infinity, -Infinity, NaN, 1.17549435e-38, 1e-40, 3.4028235e38, -3.4028235e38, 1.5, 0.75, 2.5];
const SPECIAL64 = [0, -0, 1, -1, 0.5, 2, Infinity, -Infinity, NaN, 2.2250738585072014e-308, 5e-324, 1.7976931348623157e308, -2.5, 1e10, 3.5, 0.25];

/** the inputs of case k: v0-v3, x2-x5, then NZCV in bits 31:28 of the last word */
export function inputs(k: number): Uint8Array {
  const out = new Uint8Array(INPUT_BYTES), dv = new DataView(out.buffer), rnd = prng(k + 1);
  const kind = k % 8;
  for (let i = 0; i < 64; i += 4) {
    switch (kind) {
      case 0: dv.setUint32(i, rnd(), true); break;                                                    // any bits
      case 1: dv.setFloat32(i, ((rnd() % 20000) - 10000) / 100, true); break;                          // small floats
      case 2: if (i % 8 === 0) dv.setFloat64(i, ((rnd() % 2000000) - 1000000) / 1000, true); break;    // small doubles
      case 3: dv.setFloat32(i, SPECIAL32[rnd() % 16], true); break;
      case 4: if (i % 8 === 0) dv.setFloat64(i, SPECIAL64[rnd() % 16], true); break;
      case 5: dv.setInt32(i, (rnd() % 81) - 40, true); break;                                         // small ints
      case 6: for (let b = 0; b < 4; b++) out[i + b] = ((rnd() % 17) - 8) & 0xff; break;              // small bytes
      default: for (let b = 0; b < 4; b += 2) dv.setInt16(i + b, (rnd() % 601) - 300, true); break;  // small halfwords
    }
  }
  for (let i = 64; i < 96; i += 8) {
    if (kind === 1 || kind === 3) { dv.setFloat32(i, SPECIAL32[rnd() % 16], true); dv.setUint32(i + 4, rnd() % 64, true); }
    else if (kind === 5 || kind === 6) { dv.setInt32(i, (rnd() % 81) - 40, true); dv.setInt32(i + 4, rnd() % 2 ? -1 : 0, true); }
    else { dv.setUint32(i, rnd(), true); dv.setUint32(i + 4, rnd(), true); }
  }
  dv.setUint32(96, (rnd() & 15) << 28, true);
  return out;
}
