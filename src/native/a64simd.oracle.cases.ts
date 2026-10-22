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
sub v0.8b, v1.8b, v2.8b|sub v0.4h, v1.4h, v2.4h|sub v0.8h, v1.8h, v2.8h|sub v0.2s, v1.2s, v2.2s|sqadd v0.8b, v1.8b, v2.8b|sqadd v0.4h, v1.4h, v2.4h|sqadd v0.2s, v1.2s, v2.2s|sqadd v0.2d, v1.2d, v2.2d
uqadd v0.8b, v1.8b, v2.8b|uqadd v0.4h, v1.4h, v2.4h|uqadd v0.8h, v1.8h, v2.8h|uqadd v0.2s, v1.2s, v2.2s|uqadd v0.2d, v1.2d, v2.2d|sqsub v0.8b, v1.8b, v2.8b|sqsub v0.16b, v1.16b, v2.16b
sqsub v0.4h, v1.4h, v2.4h|sqsub v0.2s, v1.2s, v2.2s|sqsub v0.2d, v1.2d, v2.2d|uqsub v0.8b, v1.8b, v2.8b|uqsub v0.4h, v1.4h, v2.4h|uqsub v0.8h, v1.8h, v2.8h|uqsub v0.2s, v1.2s, v2.2s
uqsub v0.2d, v1.2d, v2.2d|sshl v0.8b, v1.8b, v2.8b|sshl v0.4h, v1.4h, v2.4h|sshl v0.2s, v1.2s, v2.2s|ushl v0.8b, v1.8b, v2.8b|ushl v0.4h, v1.4h, v2.4h|ushl v0.8h, v1.8h, v2.8h|ushl v0.2s, v1.2s, v2.2s
srshl v0.8b, v1.8b, v2.8b|srshl v0.16b, v1.16b, v2.16b|srshl v0.4h, v1.4h, v2.4h|srshl v0.2s, v1.2s, v2.2s|srshl v0.2d, v1.2d, v2.2d|urshl v0.8b, v1.8b, v2.8b|urshl v0.4h, v1.4h, v2.4h
urshl v0.8h, v1.8h, v2.8h|urshl v0.2s, v1.2s, v2.2s|urshl v0.4s, v1.4s, v2.4s|urshl v0.2d, v1.2d, v2.2d|sqshl v0.8b, v1.8b, v2.8b|sqshl v0.16b, v1.16b, v2.16b|sqshl v0.4h, v1.4h, v2.4h
sqshl v0.2s, v1.2s, v2.2s|sqshl v0.2d, v1.2d, v2.2d|uqshl v0.8b, v1.8b, v2.8b|uqshl v0.4h, v1.4h, v2.4h|uqshl v0.8h, v1.8h, v2.8h|uqshl v0.2s, v1.2s, v2.2s|uqshl v0.4s, v1.4s, v2.4s
uqshl v0.2d, v1.2d, v2.2d|sqrshl v0.8b, v1.8b, v2.8b|sqrshl v0.16b, v1.16b, v2.16b|sqrshl v0.4h, v1.4h, v2.4h|sqrshl v0.8h, v1.8h, v2.8h|sqrshl v0.2s, v1.2s, v2.2s|uqrshl v0.8b, v1.8b, v2.8b
uqrshl v0.16b, v1.16b, v2.16b|uqrshl v0.4h, v1.4h, v2.4h|uqrshl v0.2s, v1.2s, v2.2s|uqrshl v0.4s, v1.4s, v2.4s|uqrshl v0.2d, v1.2d, v2.2d|cmeq v0.8b, v1.8b, v2.8b|cmeq v0.4h, v1.4h, v2.4h
cmeq v0.8h, v1.8h, v2.8h|cmeq v0.2s, v1.2s, v2.2s|cmgt v0.8b, v1.8b, v2.8b|cmgt v0.16b, v1.16b, v2.16b|cmgt v0.4h, v1.4h, v2.4h|cmgt v0.2s, v1.2s, v2.2s|cmge v0.8b, v1.8b, v2.8b
cmge v0.4h, v1.4h, v2.4h|cmge v0.8h, v1.8h, v2.8h|cmge v0.2s, v1.2s, v2.2s|cmge v0.4s, v1.4s, v2.4s|cmhi v0.8b, v1.8b, v2.8b|cmhi v0.16b, v1.16b, v2.16b|cmhi v0.4h, v1.4h, v2.4h
cmhi v0.8h, v1.8h, v2.8h|cmhi v0.2s, v1.2s, v2.2s|cmhs v0.8b, v1.8b, v2.8b|cmhs v0.16b, v1.16b, v2.16b|cmhs v0.4h, v1.4h, v2.4h|cmhs v0.2s, v1.2s, v2.2s|cmhs v0.4s, v1.4s, v2.4s
cmtst v0.8b, v1.8b, v2.8b|cmtst v0.16b, v1.16b, v2.16b|cmtst v0.4h, v1.4h, v2.4h|cmtst v0.8h, v1.8h, v2.8h|cmtst v0.2s, v1.2s, v2.2s|addp v0.8b, v1.8b, v2.8b|addp v0.4h, v1.4h, v2.4h
addp v0.8h, v1.8h, v2.8h|addp v0.2s, v1.2s, v2.2s|mul v0.8b, v1.8b, v2.8b|mul v0.4h, v1.4h, v2.4h|mul v0.2s, v1.2s, v2.2s|mla v0.8b, v1.8b, v2.8b|mla v0.16b, v1.16b, v2.16b|mla v0.4h, v1.4h, v2.4h
mla v0.2s, v1.2s, v2.2s|mls v0.8b, v1.8b, v2.8b|mls v0.4h, v1.4h, v2.4h|mls v0.8h, v1.8h, v2.8h|mls v0.2s, v1.2s, v2.2s|mls v0.4s, v1.4s, v2.4s|smax v0.8b, v1.8b, v2.8b|smax v0.4h, v1.4h, v2.4h
smax v0.8h, v1.8h, v2.8h|smax v0.2s, v1.2s, v2.2s|smin v0.8b, v1.8b, v2.8b|smin v0.16b, v1.16b, v2.16b|smin v0.4h, v1.4h, v2.4h|smin v0.2s, v1.2s, v2.2s|smin v0.4s, v1.4s, v2.4s
umax v0.8b, v1.8b, v2.8b|umax v0.4h, v1.4h, v2.4h|umax v0.8h, v1.8h, v2.8h|umax v0.2s, v1.2s, v2.2s|umin v0.8b, v1.8b, v2.8b|umin v0.16b, v1.16b, v2.16b|umin v0.4h, v1.4h, v2.4h
umin v0.2s, v1.2s, v2.2s|umin v0.4s, v1.4s, v2.4s|shadd v0.8b, v1.8b, v2.8b|shadd v0.16b, v1.16b, v2.16b|shadd v0.4h, v1.4h, v2.4h|shadd v0.2s, v1.2s, v2.2s|shadd v0.4s, v1.4s, v2.4s
uhadd v0.8b, v1.8b, v2.8b|uhadd v0.4h, v1.4h, v2.4h|uhadd v0.8h, v1.8h, v2.8h|uhadd v0.2s, v1.2s, v2.2s|uhadd v0.4s, v1.4s, v2.4s|srhadd v0.8b, v1.8b, v2.8b|srhadd v0.16b, v1.16b, v2.16b
srhadd v0.4h, v1.4h, v2.4h|srhadd v0.8h, v1.8h, v2.8h|srhadd v0.2s, v1.2s, v2.2s|urhadd v0.8b, v1.8b, v2.8b|urhadd v0.16b, v1.16b, v2.16b|urhadd v0.4h, v1.4h, v2.4h|urhadd v0.2s, v1.2s, v2.2s
urhadd v0.4s, v1.4s, v2.4s|shsub v0.8b, v1.8b, v2.8b|shsub v0.4h, v1.4h, v2.4h|shsub v0.8h, v1.8h, v2.8h|shsub v0.2s, v1.2s, v2.2s|shsub v0.4s, v1.4s, v2.4s|uhsub v0.8b, v1.8b, v2.8b
uhsub v0.16b, v1.16b, v2.16b|uhsub v0.4h, v1.4h, v2.4h|uhsub v0.8h, v1.8h, v2.8h|uhsub v0.2s, v1.2s, v2.2s|sabd v0.8b, v1.8b, v2.8b|sabd v0.4h, v1.4h, v2.4h|sabd v0.8h, v1.8h, v2.8h
sabd v0.2s, v1.2s, v2.2s|uabd v0.8b, v1.8b, v2.8b|uabd v0.16b, v1.16b, v2.16b|uabd v0.4h, v1.4h, v2.4h|uabd v0.2s, v1.2s, v2.2s|uabd v0.4s, v1.4s, v2.4s|saba v0.8b, v1.8b, v2.8b
saba v0.16b, v1.16b, v2.16b|saba v0.4h, v1.4h, v2.4h|saba v0.8h, v1.8h, v2.8h|saba v0.2s, v1.2s, v2.2s|uaba v0.8b, v1.8b, v2.8b|uaba v0.4h, v1.4h, v2.4h|uaba v0.8h, v1.8h, v2.8h
uaba v0.2s, v1.2s, v2.2s|uaba v0.4s, v1.4s, v2.4s|smaxp v0.8b, v1.8b, v2.8b|smaxp v0.16b, v1.16b, v2.16b|smaxp v0.4h, v1.4h, v2.4h|smaxp v0.8h, v1.8h, v2.8h|smaxp v0.2s, v1.2s, v2.2s
sminp v0.8b, v1.8b, v2.8b|sminp v0.16b, v1.16b, v2.16b|sminp v0.4h, v1.4h, v2.4h|sminp v0.2s, v1.2s, v2.2s|sminp v0.4s, v1.4s, v2.4s|umaxp v0.8b, v1.8b, v2.8b|umaxp v0.4h, v1.4h, v2.4h
umaxp v0.8h, v1.8h, v2.8h|umaxp v0.2s, v1.2s, v2.2s|umaxp v0.4s, v1.4s, v2.4s|uminp v0.8b, v1.8b, v2.8b|uminp v0.16b, v1.16b, v2.16b|uminp v0.4h, v1.4h, v2.4h|uminp v0.8h, v1.8h, v2.8h
uminp v0.2s, v1.2s, v2.2s|sqdmulh v0.4h, v1.4h, v2.4h|sqdmulh v0.8h, v1.8h, v2.8h|sqdmulh v0.2s, v1.2s, v2.2s|sqrdmulh v0.4h, v1.4h, v2.4h|sqrdmulh v0.2s, v1.2s, v2.2s|sqrdmulh v0.4s, v1.4s, v2.4s
pmul v0.8b, v1.8b, v2.8b|pmul v0.16b, v1.16b, v2.16b|bic v0.8b, v1.8b, v2.8b|orn v0.8b, v1.8b, v2.8b|eor v0.8b, v1.8b, v2.8b|bsl v0.8b, v1.8b, v2.8b|bit v0.8b, v1.8b, v2.8b|bif v0.8b, v1.8b, v2.8b
abs v0.8b, v1.8b|abs v0.16b, v1.16b|abs v0.4h, v1.4h|abs v0.2s, v1.2s|neg v0.8b, v1.8b|neg v0.4h, v1.4h|neg v0.8h, v1.8h|neg v0.2s, v1.2s|sqabs v0.8b, v1.8b|sqabs v0.16b, v1.16b|sqabs v0.4h, v1.4h
sqabs v0.2s, v1.2s|sqabs v0.2d, v1.2d|sqneg v0.8b, v1.8b|sqneg v0.4h, v1.4h|sqneg v0.8h, v1.8h|sqneg v0.2s, v1.2s|sqneg v0.4s, v1.4s|sqneg v0.2d, v1.2d|cmeq v0.8b, v1.8b, #0|cmeq v0.16b, v1.16b, #0
cmeq v0.4h, v1.4h, #0|cmeq v0.8h, v1.8h, #0|cmeq v0.2s, v1.2s, #0|cmgt v0.8b, v1.8b, #0|cmgt v0.16b, v1.16b, #0|cmgt v0.4h, v1.4h, #0|cmgt v0.8h, v1.8h, #0|cmgt v0.2s, v1.2s, #0|cmgt v0.4s, v1.4s, #0
cmge v0.8b, v1.8b, #0|cmge v0.4h, v1.4h, #0|cmge v0.8h, v1.8h, #0|cmge v0.2s, v1.2s, #0|cmge v0.4s, v1.4s, #0|cmle v0.8b, v1.8b, #0|cmle v0.16b, v1.16b, #0|cmle v0.4h, v1.4h, #0|cmle v0.2s, v1.2s, #0
cmle v0.4s, v1.4s, #0|cmlt v0.8b, v1.8b, #0|cmlt v0.16b, v1.16b, #0|cmlt v0.4h, v1.4h, #0|cmlt v0.8h, v1.8h, #0|cmlt v0.2s, v1.2s, #0|cls v0.8b, v1.8b|cls v0.4h, v1.4h|cls v0.8h, v1.8h
cls v0.2s, v1.2s|clz v0.8b, v1.8b|clz v0.4h, v1.4h|clz v0.2s, v1.2s|rbit v0.8b, v1.8b|rev16 v0.8b, v1.8b|rev32 v0.8b, v1.8b|rev32 v0.4h, v1.4h|rev64 v0.8b, v1.8b|rev64 v0.4h, v1.4h|rev64 v0.2s, v1.2s
saddlp v0.4h, v1.8b|saddlp v0.8h, v1.16b|saddlp v0.2s, v1.4h|saddlp v0.1d, v1.2s|uaddlp v0.4h, v1.8b|uaddlp v0.2s, v1.4h|uaddlp v0.4s, v1.8h|uaddlp v0.1d, v1.2s|uaddlp v0.2d, v1.4s|sadalp v0.4h, v1.8b
sadalp v0.8h, v1.16b|sadalp v0.2s, v1.4h|sadalp v0.1d, v1.2s|sadalp v0.2d, v1.4s|uadalp v0.4h, v1.8b|uadalp v0.8h, v1.16b|uadalp v0.2s, v1.4h|uadalp v0.4s, v1.8h|uadalp v0.1d, v1.2s|xtn v0.8b, v1.8h
xtn2 v0.4s, v1.2d|sqxtn v0.8b, v1.8h|sqxtn2 v0.8h, v1.4s|sqxtn v0.2s, v1.2d|sqxtn2 v0.4s, v1.2d|uqxtn v0.8b, v1.8h|uqxtn2 v0.16b, v1.8h|uqxtn v0.4h, v1.4s|uqxtn2 v0.4s, v1.2d|sqxtun2 v0.16b, v1.8h
sqxtun v0.4h, v1.4s|sqxtun2 v0.8h, v1.4s|sqxtun v0.2s, v1.2d|fsub v0.2s, v1.2s, v2.2s|fdiv v0.2s, v1.2s, v2.2s|fmax v0.2s, v1.2s, v2.2s|fmax v0.2d, v1.2d, v2.2d|fmin v0.2s, v1.2s, v2.2s
fmin v0.4s, v1.4s, v2.4s|fmaxnm v0.2s, v1.2s, v2.2s|fmaxnm v0.2d, v1.2d, v2.2d|fminnm v0.4s, v1.4s, v2.4s|fminnm v0.2d, v1.2d, v2.2d|fmla v0.2d, v1.2d, v2.2d|fmls v0.2s, v1.2s, v2.2s
fmls v0.4s, v1.4s, v2.4s|fabd v0.2s, v1.2s, v2.2s|fabd v0.2d, v1.2d, v2.2d|fmulx v0.2s, v1.2s, v2.2s|fmulx v0.2d, v1.2d, v2.2d|fcmeq v0.2s, v1.2s, v2.2s|fcmeq v0.2d, v1.2d, v2.2d
fcmge v0.2s, v1.2s, v2.2s|fcmge v0.2d, v1.2d, v2.2d|fcmgt v0.2s, v1.2s, v2.2s|fcmgt v0.4s, v1.4s, v2.4s|facge v0.2s, v1.2s, v2.2s|facge v0.2d, v1.2d, v2.2d|facgt v0.2s, v1.2s, v2.2s
facgt v0.4s, v1.4s, v2.4s|faddp v0.2s, v1.2s, v2.2s|fmaxp v0.4s, v1.4s, v2.4s|fmaxp v0.2d, v1.2d, v2.2d|fminp v0.2s, v1.2s, v2.2s|fminp v0.2d, v1.2d, v2.2d|fmaxnmp v0.2s, v1.2s, v2.2s
fmaxnmp v0.4s, v1.4s, v2.4s|fminnmp v0.2s, v1.2s, v2.2s|fminnmp v0.2d, v1.2d, v2.2d|frecps v0.2s, v1.2s, v2.2s|frecps v0.2d, v1.2d, v2.2d|frsqrts v0.2s, v1.2s, v2.2s|frsqrts v0.4s, v1.4s, v2.4s
fabs v0.2s, v1.2s|fabs v0.4s, v1.4s|fneg v0.2s, v1.2s|fneg v0.2d, v1.2d|fsqrt v0.2s, v1.2s|frintn v0.2s, v1.2s|frintn v0.2d, v1.2d|frintp v0.2s, v1.2s|frintp v0.2d, v1.2d|frintm v0.2s, v1.2s
frintm v0.4s, v1.4s|frintz v0.4s, v1.4s|frintz v0.2d, v1.2d|frinta v0.2s, v1.2s|frinta v0.2d, v1.2d|frintx v0.2s, v1.2s|frintx v0.4s, v1.4s|frinti v0.2s, v1.2s|frinti v0.2d, v1.2d|frecpe v0.2d, v1.2d
frsqrte v0.2s, v1.2s|frsqrte v0.4s, v1.4s|fcvtns v0.2s, v1.2s|fcvtns v0.2d, v1.2d|fcvtnu v0.2s, v1.2s|fcvtnu v0.4s, v1.4s|fcvtps v0.4s, v1.4s|fcvtps v0.2d, v1.2d|fcvtpu v0.2s, v1.2s
fcvtpu v0.4s, v1.4s|fcvtpu v0.2d, v1.2d|fcvtms v0.2s, v1.2s|fcvtms v0.4s, v1.4s|fcvtmu v0.2s, v1.2s|fcvtmu v0.4s, v1.4s|fcvtmu v0.2d, v1.2d|fcvtzs v0.2d, v1.2d|fcvtzu v0.2s, v1.2s|fcvtas v0.2s, v1.2s
fcvtas v0.2d, v1.2d|fcvtau v0.2s, v1.2s|fcvtau v0.2d, v1.2d|ucvtf v0.2s, v1.2s|fcmeq v0.2s, v1.2s, #0.0|fcmeq v0.2d, v1.2d, #0.0|fcmge v0.2s, v1.2s, #0.0|fcmge v0.2d, v1.2d, #0.0
fcmgt v0.2s, v1.2s, #0.0|fcmgt v0.4s, v1.4s, #0.0|fcmle v0.4s, v1.4s, #0.0|fcmle v0.2d, v1.2d, #0.0|fcmlt v0.2s, v1.2s, #0.0|fcmlt v0.2d, v1.2d, #0.0|shl v0.8b, v1.8b, #1|sqshl v0.8b, v1.8b, #1
uqshl v0.8b, v1.8b, #1|sqshlu v0.8b, v1.8b, #1|sli v0.8b, v1.8b, #1|shl v0.8b, v1.8b, #4|sqshl v0.8b, v1.8b, #4|uqshl v0.8b, v1.8b, #4|sqshlu v0.8b, v1.8b, #4|sli v0.8b, v1.8b, #4|shl v0.8b, v1.8b, #7
sqshl v0.8b, v1.8b, #7|uqshl v0.8b, v1.8b, #7|sqshlu v0.8b, v1.8b, #7|sli v0.8b, v1.8b, #7|sshr v0.8b, v1.8b, #1|ushr v0.8b, v1.8b, #1|ssra v0.8b, v1.8b, #1|usra v0.8b, v1.8b, #1
srshr v0.8b, v1.8b, #1|urshr v0.8b, v1.8b, #1|srsra v0.8b, v1.8b, #1|ursra v0.8b, v1.8b, #1|sri v0.8b, v1.8b, #1|sshr v0.8b, v1.8b, #4|ushr v0.8b, v1.8b, #4|ssra v0.8b, v1.8b, #4|usra v0.8b, v1.8b, #4
srshr v0.8b, v1.8b, #4|urshr v0.8b, v1.8b, #4|srsra v0.8b, v1.8b, #4|ursra v0.8b, v1.8b, #4|sri v0.8b, v1.8b, #4|sshr v0.8b, v1.8b, #8|ssra v0.8b, v1.8b, #8|usra v0.8b, v1.8b, #8
srshr v0.8b, v1.8b, #8|urshr v0.8b, v1.8b, #8|srsra v0.8b, v1.8b, #8|ursra v0.8b, v1.8b, #8|sri v0.8b, v1.8b, #8|shl v0.16b, v1.16b, #1|sqshl v0.16b, v1.16b, #1|uqshl v0.16b, v1.16b, #1
sli v0.16b, v1.16b, #1|shl v0.16b, v1.16b, #4|sqshl v0.16b, v1.16b, #4|uqshl v0.16b, v1.16b, #4|sqshlu v0.16b, v1.16b, #4|sli v0.16b, v1.16b, #4|sqshl v0.16b, v1.16b, #7|uqshl v0.16b, v1.16b, #7
sqshlu v0.16b, v1.16b, #7|sli v0.16b, v1.16b, #7|sshr v0.16b, v1.16b, #1|ushr v0.16b, v1.16b, #1|ssra v0.16b, v1.16b, #1|usra v0.16b, v1.16b, #1|srshr v0.16b, v1.16b, #1|urshr v0.16b, v1.16b, #1
srsra v0.16b, v1.16b, #1|ursra v0.16b, v1.16b, #1|sri v0.16b, v1.16b, #1|sshr v0.16b, v1.16b, #4|ushr v0.16b, v1.16b, #4|ssra v0.16b, v1.16b, #4|usra v0.16b, v1.16b, #4|srshr v0.16b, v1.16b, #4
urshr v0.16b, v1.16b, #4|srsra v0.16b, v1.16b, #4|ursra v0.16b, v1.16b, #4|sri v0.16b, v1.16b, #4|sshr v0.16b, v1.16b, #8|ushr v0.16b, v1.16b, #8|ssra v0.16b, v1.16b, #8|usra v0.16b, v1.16b, #8
srshr v0.16b, v1.16b, #8|urshr v0.16b, v1.16b, #8|srsra v0.16b, v1.16b, #8|ursra v0.16b, v1.16b, #8|sri v0.16b, v1.16b, #8|shl v0.4h, v1.4h, #1|sqshl v0.4h, v1.4h, #1|uqshl v0.4h, v1.4h, #1
sqshlu v0.4h, v1.4h, #1|sli v0.4h, v1.4h, #1|shl v0.4h, v1.4h, #8|sqshl v0.4h, v1.4h, #8|uqshl v0.4h, v1.4h, #8|sqshlu v0.4h, v1.4h, #8|sli v0.4h, v1.4h, #8|shl v0.4h, v1.4h, #15
sqshl v0.4h, v1.4h, #15|uqshl v0.4h, v1.4h, #15|sqshlu v0.4h, v1.4h, #15|sli v0.4h, v1.4h, #15|sshr v0.4h, v1.4h, #1|ushr v0.4h, v1.4h, #1|ssra v0.4h, v1.4h, #1|usra v0.4h, v1.4h, #1
srshr v0.4h, v1.4h, #1|urshr v0.4h, v1.4h, #1|srsra v0.4h, v1.4h, #1|ursra v0.4h, v1.4h, #1|sri v0.4h, v1.4h, #1|sshr v0.4h, v1.4h, #8|ushr v0.4h, v1.4h, #8|ssra v0.4h, v1.4h, #8|usra v0.4h, v1.4h, #8
srshr v0.4h, v1.4h, #8|urshr v0.4h, v1.4h, #8|srsra v0.4h, v1.4h, #8|ursra v0.4h, v1.4h, #8|sri v0.4h, v1.4h, #8|sshr v0.4h, v1.4h, #16|ushr v0.4h, v1.4h, #16|ssra v0.4h, v1.4h, #16
usra v0.4h, v1.4h, #16|srshr v0.4h, v1.4h, #16|urshr v0.4h, v1.4h, #16|srsra v0.4h, v1.4h, #16|ursra v0.4h, v1.4h, #16|sri v0.4h, v1.4h, #16|shl v0.8h, v1.8h, #1|sqshl v0.8h, v1.8h, #1
uqshl v0.8h, v1.8h, #1|sqshlu v0.8h, v1.8h, #1|sli v0.8h, v1.8h, #1|shl v0.8h, v1.8h, #8|sqshl v0.8h, v1.8h, #8|uqshl v0.8h, v1.8h, #8|sqshlu v0.8h, v1.8h, #8|sli v0.8h, v1.8h, #8
sqshl v0.8h, v1.8h, #15|uqshl v0.8h, v1.8h, #15|sqshlu v0.8h, v1.8h, #15|sli v0.8h, v1.8h, #15|sshr v0.8h, v1.8h, #1|ushr v0.8h, v1.8h, #1|ssra v0.8h, v1.8h, #1|usra v0.8h, v1.8h, #1
srshr v0.8h, v1.8h, #1|urshr v0.8h, v1.8h, #1|srsra v0.8h, v1.8h, #1|ursra v0.8h, v1.8h, #1|sri v0.8h, v1.8h, #1|sshr v0.8h, v1.8h, #8|ushr v0.8h, v1.8h, #8|ssra v0.8h, v1.8h, #8|usra v0.8h, v1.8h, #8
srshr v0.8h, v1.8h, #8|urshr v0.8h, v1.8h, #8|srsra v0.8h, v1.8h, #8|ursra v0.8h, v1.8h, #8|sri v0.8h, v1.8h, #8|sshr v0.8h, v1.8h, #16|ushr v0.8h, v1.8h, #16|ssra v0.8h, v1.8h, #16
usra v0.8h, v1.8h, #16|srshr v0.8h, v1.8h, #16|urshr v0.8h, v1.8h, #16|srsra v0.8h, v1.8h, #16|ursra v0.8h, v1.8h, #16|sri v0.8h, v1.8h, #16|shl v0.2s, v1.2s, #1|sqshl v0.2s, v1.2s, #1
uqshl v0.2s, v1.2s, #1|sqshlu v0.2s, v1.2s, #1|sli v0.2s, v1.2s, #1|shl v0.2s, v1.2s, #16|sqshl v0.2s, v1.2s, #16|uqshl v0.2s, v1.2s, #16|sqshlu v0.2s, v1.2s, #16|sli v0.2s, v1.2s, #16
shl v0.2s, v1.2s, #31|sqshl v0.2s, v1.2s, #31|uqshl v0.2s, v1.2s, #31|sqshlu v0.2s, v1.2s, #31|sli v0.2s, v1.2s, #31|sshr v0.2s, v1.2s, #1|ushr v0.2s, v1.2s, #1|ssra v0.2s, v1.2s, #1
usra v0.2s, v1.2s, #1|srshr v0.2s, v1.2s, #1|urshr v0.2s, v1.2s, #1|srsra v0.2s, v1.2s, #1|ursra v0.2s, v1.2s, #1|sri v0.2s, v1.2s, #1|sshr v0.2s, v1.2s, #16|ushr v0.2s, v1.2s, #16
ssra v0.2s, v1.2s, #16|usra v0.2s, v1.2s, #16|srshr v0.2s, v1.2s, #16|urshr v0.2s, v1.2s, #16|srsra v0.2s, v1.2s, #16|ursra v0.2s, v1.2s, #16|sri v0.2s, v1.2s, #16|sshr v0.2s, v1.2s, #32
ushr v0.2s, v1.2s, #32|ssra v0.2s, v1.2s, #32|usra v0.2s, v1.2s, #32|srshr v0.2s, v1.2s, #32|urshr v0.2s, v1.2s, #32|srsra v0.2s, v1.2s, #32|ursra v0.2s, v1.2s, #32|sri v0.2s, v1.2s, #32
shl v0.4s, v1.4s, #1|sqshl v0.4s, v1.4s, #1|uqshl v0.4s, v1.4s, #1|sqshlu v0.4s, v1.4s, #1|sli v0.4s, v1.4s, #1|shl v0.4s, v1.4s, #16|sqshl v0.4s, v1.4s, #16|uqshl v0.4s, v1.4s, #16
sqshlu v0.4s, v1.4s, #16|sli v0.4s, v1.4s, #16|shl v0.4s, v1.4s, #31|sqshl v0.4s, v1.4s, #31|uqshl v0.4s, v1.4s, #31|sqshlu v0.4s, v1.4s, #31|sli v0.4s, v1.4s, #31|ushr v0.4s, v1.4s, #1
ssra v0.4s, v1.4s, #1|usra v0.4s, v1.4s, #1|srshr v0.4s, v1.4s, #1|urshr v0.4s, v1.4s, #1|srsra v0.4s, v1.4s, #1|ursra v0.4s, v1.4s, #1|sri v0.4s, v1.4s, #1|sshr v0.4s, v1.4s, #16
ushr v0.4s, v1.4s, #16|ssra v0.4s, v1.4s, #16|usra v0.4s, v1.4s, #16|srshr v0.4s, v1.4s, #16|urshr v0.4s, v1.4s, #16|srsra v0.4s, v1.4s, #16|ursra v0.4s, v1.4s, #16|sri v0.4s, v1.4s, #16
sshr v0.4s, v1.4s, #32|ssra v0.4s, v1.4s, #32|usra v0.4s, v1.4s, #32|srshr v0.4s, v1.4s, #32|urshr v0.4s, v1.4s, #32|srsra v0.4s, v1.4s, #32|ursra v0.4s, v1.4s, #32|sri v0.4s, v1.4s, #32
shl v0.2d, v1.2d, #1|sqshl v0.2d, v1.2d, #1|uqshl v0.2d, v1.2d, #1|sqshlu v0.2d, v1.2d, #1|sli v0.2d, v1.2d, #1|shl v0.2d, v1.2d, #32|sqshl v0.2d, v1.2d, #32|uqshl v0.2d, v1.2d, #32
sqshlu v0.2d, v1.2d, #32|sli v0.2d, v1.2d, #32|shl v0.2d, v1.2d, #63|sqshl v0.2d, v1.2d, #63|uqshl v0.2d, v1.2d, #63|sqshlu v0.2d, v1.2d, #63|sli v0.2d, v1.2d, #63|sshr v0.2d, v1.2d, #1
ssra v0.2d, v1.2d, #1|usra v0.2d, v1.2d, #1|srshr v0.2d, v1.2d, #1|urshr v0.2d, v1.2d, #1|srsra v0.2d, v1.2d, #1|ursra v0.2d, v1.2d, #1|sri v0.2d, v1.2d, #1|sshr v0.2d, v1.2d, #32
ushr v0.2d, v1.2d, #32|ssra v0.2d, v1.2d, #32|usra v0.2d, v1.2d, #32|srshr v0.2d, v1.2d, #32|urshr v0.2d, v1.2d, #32|srsra v0.2d, v1.2d, #32|ursra v0.2d, v1.2d, #32|sri v0.2d, v1.2d, #32
sshr v0.2d, v1.2d, #64|ushr v0.2d, v1.2d, #64|ssra v0.2d, v1.2d, #64|usra v0.2d, v1.2d, #64|srshr v0.2d, v1.2d, #64|urshr v0.2d, v1.2d, #64|srsra v0.2d, v1.2d, #64|ursra v0.2d, v1.2d, #64
shrn v0.8b, v1.8h, #1|shrn2 v0.16b, v1.8h, #1|rshrn v0.8b, v1.8h, #1|rshrn2 v0.16b, v1.8h, #1|sqshrn v0.8b, v1.8h, #1|sqshrn2 v0.16b, v1.8h, #1|uqshrn v0.8b, v1.8h, #1|uqshrn2 v0.16b, v1.8h, #1
sqrshrn v0.8b, v1.8h, #1|sqrshrn2 v0.16b, v1.8h, #1|uqrshrn2 v0.16b, v1.8h, #1|sqshrun v0.8b, v1.8h, #1|sqshrun2 v0.16b, v1.8h, #1|sqrshrun v0.8b, v1.8h, #1|sqrshrun2 v0.16b, v1.8h, #1
shrn v0.8b, v1.8h, #4|shrn2 v0.16b, v1.8h, #4|rshrn v0.8b, v1.8h, #4|rshrn2 v0.16b, v1.8h, #4|sqshrn v0.8b, v1.8h, #4|sqshrn2 v0.16b, v1.8h, #4|uqshrn v0.8b, v1.8h, #4|uqshrn2 v0.16b, v1.8h, #4
sqrshrn v0.8b, v1.8h, #4|sqrshrn2 v0.16b, v1.8h, #4|uqrshrn v0.8b, v1.8h, #4|uqrshrn2 v0.16b, v1.8h, #4|sqshrun v0.8b, v1.8h, #4|sqshrun2 v0.16b, v1.8h, #4|sqrshrun v0.8b, v1.8h, #4
sqrshrun2 v0.16b, v1.8h, #4|shrn v0.8b, v1.8h, #8|shrn2 v0.16b, v1.8h, #8|rshrn v0.8b, v1.8h, #8|rshrn2 v0.16b, v1.8h, #8|sqshrn v0.8b, v1.8h, #8|sqshrn2 v0.16b, v1.8h, #8|uqshrn v0.8b, v1.8h, #8
uqshrn2 v0.16b, v1.8h, #8|sqrshrn v0.8b, v1.8h, #8|sqrshrn2 v0.16b, v1.8h, #8|uqrshrn v0.8b, v1.8h, #8|uqrshrn2 v0.16b, v1.8h, #8|sqshrun v0.8b, v1.8h, #8|sqshrun2 v0.16b, v1.8h, #8
sqrshrun v0.8b, v1.8h, #8|sqrshrun2 v0.16b, v1.8h, #8|shrn v0.4h, v1.4s, #1|shrn2 v0.8h, v1.4s, #1|rshrn v0.4h, v1.4s, #1|rshrn2 v0.8h, v1.4s, #1|sqshrn v0.4h, v1.4s, #1|sqshrn2 v0.8h, v1.4s, #1
uqshrn v0.4h, v1.4s, #1|uqshrn2 v0.8h, v1.4s, #1|sqrshrn v0.4h, v1.4s, #1|sqrshrn2 v0.8h, v1.4s, #1|uqrshrn v0.4h, v1.4s, #1|uqrshrn2 v0.8h, v1.4s, #1|sqshrun v0.4h, v1.4s, #1
sqshrun2 v0.8h, v1.4s, #1|sqrshrun v0.4h, v1.4s, #1|sqrshrun2 v0.8h, v1.4s, #1|shrn v0.4h, v1.4s, #8|shrn2 v0.8h, v1.4s, #8|rshrn v0.4h, v1.4s, #8|rshrn2 v0.8h, v1.4s, #8|sqshrn v0.4h, v1.4s, #8
sqshrn2 v0.8h, v1.4s, #8|uqshrn v0.4h, v1.4s, #8|uqshrn2 v0.8h, v1.4s, #8|sqrshrn v0.4h, v1.4s, #8|sqrshrn2 v0.8h, v1.4s, #8|uqrshrn v0.4h, v1.4s, #8|uqrshrn2 v0.8h, v1.4s, #8|sqshrun v0.4h, v1.4s, #8
sqshrun2 v0.8h, v1.4s, #8|sqrshrun v0.4h, v1.4s, #8|sqrshrun2 v0.8h, v1.4s, #8|shrn v0.4h, v1.4s, #16|shrn2 v0.8h, v1.4s, #16|rshrn v0.4h, v1.4s, #16|rshrn2 v0.8h, v1.4s, #16|sqshrn v0.4h, v1.4s, #16
sqshrn2 v0.8h, v1.4s, #16|uqshrn v0.4h, v1.4s, #16|uqshrn2 v0.8h, v1.4s, #16|sqrshrn v0.4h, v1.4s, #16|sqrshrn2 v0.8h, v1.4s, #16|uqrshrn v0.4h, v1.4s, #16|uqrshrn2 v0.8h, v1.4s, #16
sqshrun v0.4h, v1.4s, #16|sqshrun2 v0.8h, v1.4s, #16|sqrshrun v0.4h, v1.4s, #16|sqrshrun2 v0.8h, v1.4s, #16|shrn v0.2s, v1.2d, #1|shrn2 v0.4s, v1.2d, #1|rshrn v0.2s, v1.2d, #1|rshrn2 v0.4s, v1.2d, #1
sqshrn v0.2s, v1.2d, #1|sqshrn2 v0.4s, v1.2d, #1|uqshrn v0.2s, v1.2d, #1|uqshrn2 v0.4s, v1.2d, #1|sqrshrn v0.2s, v1.2d, #1|sqrshrn2 v0.4s, v1.2d, #1|uqrshrn v0.2s, v1.2d, #1|uqrshrn2 v0.4s, v1.2d, #1
sqshrun v0.2s, v1.2d, #1|sqshrun2 v0.4s, v1.2d, #1|sqrshrun v0.2s, v1.2d, #1|sqrshrun2 v0.4s, v1.2d, #1|shrn v0.2s, v1.2d, #16|shrn2 v0.4s, v1.2d, #16|rshrn v0.2s, v1.2d, #16|rshrn2 v0.4s, v1.2d, #16
sqshrn v0.2s, v1.2d, #16|sqshrn2 v0.4s, v1.2d, #16|uqshrn v0.2s, v1.2d, #16|uqshrn2 v0.4s, v1.2d, #16|sqrshrn v0.2s, v1.2d, #16|sqrshrn2 v0.4s, v1.2d, #16|uqrshrn v0.2s, v1.2d, #16
uqrshrn2 v0.4s, v1.2d, #16|sqshrun v0.2s, v1.2d, #16|sqshrun2 v0.4s, v1.2d, #16|sqrshrun v0.2s, v1.2d, #16|sqrshrun2 v0.4s, v1.2d, #16|shrn v0.2s, v1.2d, #32|shrn2 v0.4s, v1.2d, #32
rshrn v0.2s, v1.2d, #32|rshrn2 v0.4s, v1.2d, #32|sqshrn v0.2s, v1.2d, #32|sqshrn2 v0.4s, v1.2d, #32|uqshrn v0.2s, v1.2d, #32|uqshrn2 v0.4s, v1.2d, #32|sqrshrn v0.2s, v1.2d, #32
sqrshrn2 v0.4s, v1.2d, #32|uqrshrn v0.2s, v1.2d, #32|uqrshrn2 v0.4s, v1.2d, #32|sqshrun v0.2s, v1.2d, #32|sqshrun2 v0.4s, v1.2d, #32|sqrshrun v0.2s, v1.2d, #32|sqrshrun2 v0.4s, v1.2d, #32
sshll v0.8h, v1.8b, #0|sshll2 v0.8h, v1.16b, #0|ushll v0.8h, v1.8b, #0|ushll2 v0.8h, v1.16b, #0|sshll v0.8h, v1.8b, #7|sshll2 v0.8h, v1.16b, #7|ushll v0.8h, v1.8b, #7|saddl2 v0.8h, v1.16b, v2.16b
uaddl v0.8h, v1.8b, v2.8b|uaddl2 v0.8h, v1.16b, v2.16b|ssubl2 v0.8h, v1.16b, v2.16b|usubl v0.8h, v1.8b, v2.8b|usubl2 v0.8h, v1.16b, v2.16b|sabal v0.8h, v1.8b, v2.8b|sabal2 v0.8h, v1.16b, v2.16b
uabal v0.8h, v1.8b, v2.8b|uabal2 v0.8h, v1.16b, v2.16b|sabdl v0.8h, v1.8b, v2.8b|sabdl2 v0.8h, v1.16b, v2.16b|uabdl2 v0.8h, v1.16b, v2.16b|smull2 v0.8h, v1.16b, v2.16b|umull v0.8h, v1.8b, v2.8b
umull2 v0.8h, v1.16b, v2.16b|smlal v0.8h, v1.8b, v2.8b|smlal2 v0.8h, v1.16b, v2.16b|umlal v0.8h, v1.8b, v2.8b|umlal2 v0.8h, v1.16b, v2.16b|smlsl v0.8h, v1.8b, v2.8b|smlsl2 v0.8h, v1.16b, v2.16b
umlsl v0.8h, v1.8b, v2.8b|umlsl2 v0.8h, v1.16b, v2.16b|saddw v0.8h, v1.8h, v2.8b|saddw2 v0.8h, v1.8h, v2.16b|uaddw v0.8h, v1.8h, v2.8b|uaddw2 v0.8h, v1.8h, v2.16b|ssubw2 v0.8h, v1.8h, v2.16b
usubw v0.8h, v1.8h, v2.8b|usubw2 v0.8h, v1.8h, v2.16b|addhn v0.8b, v1.8h, v2.8h|raddhn v0.8b, v1.8h, v2.8h|raddhn2 v0.16b, v1.8h, v2.8h|subhn v0.8b, v1.8h, v2.8h|subhn2 v0.16b, v1.8h, v2.8h
rsubhn v0.8b, v1.8h, v2.8h|rsubhn2 v0.16b, v1.8h, v2.8h|ushll v0.4s, v1.4h, #0|ushll2 v0.4s, v1.8h, #0|sshll v0.4s, v1.4h, #15|sshll2 v0.4s, v1.8h, #15|ushll v0.4s, v1.4h, #15|ushll2 v0.4s, v1.8h, #15
saddl v0.4s, v1.4h, v2.4h|uaddl v0.4s, v1.4h, v2.4h|uaddl2 v0.4s, v1.8h, v2.8h|ssubl v0.4s, v1.4h, v2.4h|ssubl2 v0.4s, v1.8h, v2.8h|usubl v0.4s, v1.4h, v2.4h|usubl2 v0.4s, v1.8h, v2.8h
sabal2 v0.4s, v1.8h, v2.8h|uabal v0.4s, v1.4h, v2.4h|uabal2 v0.4s, v1.8h, v2.8h|sabdl v0.4s, v1.4h, v2.4h|sabdl2 v0.4s, v1.8h, v2.8h|uabdl v0.4s, v1.4h, v2.4h|uabdl2 v0.4s, v1.8h, v2.8h
smull v0.4s, v1.4h, v2.4h|umull v0.4s, v1.4h, v2.4h|umull2 v0.4s, v1.8h, v2.8h|smlal2 v0.4s, v1.8h, v2.8h|umlal v0.4s, v1.4h, v2.4h|umlal2 v0.4s, v1.8h, v2.8h|smlsl v0.4s, v1.4h, v2.4h
smlsl2 v0.4s, v1.8h, v2.8h|umlsl v0.4s, v1.4h, v2.4h|umlsl2 v0.4s, v1.8h, v2.8h|saddw2 v0.4s, v1.4s, v2.8h|uaddw v0.4s, v1.4s, v2.4h|uaddw2 v0.4s, v1.4s, v2.8h|ssubw v0.4s, v1.4s, v2.4h
ssubw2 v0.4s, v1.4s, v2.8h|usubw v0.4s, v1.4s, v2.4h|addhn2 v0.8h, v1.4s, v2.4s|raddhn2 v0.8h, v1.4s, v2.4s|subhn v0.4h, v1.4s, v2.4s|subhn2 v0.8h, v1.4s, v2.4s|rsubhn v0.4h, v1.4s, v2.4s
sshll v0.2d, v1.2s, #0|sshll2 v0.2d, v1.4s, #0|ushll v0.2d, v1.2s, #0|sshll v0.2d, v1.2s, #31|sshll2 v0.2d, v1.4s, #31|ushll v0.2d, v1.2s, #31|ushll2 v0.2d, v1.4s, #31|saddl v0.2d, v1.2s, v2.2s
saddl2 v0.2d, v1.4s, v2.4s|uaddl2 v0.2d, v1.4s, v2.4s|ssubl v0.2d, v1.2s, v2.2s|ssubl2 v0.2d, v1.4s, v2.4s|usubl v0.2d, v1.2s, v2.2s|sabal v0.2d, v1.2s, v2.2s|sabal2 v0.2d, v1.4s, v2.4s
uabal v0.2d, v1.2s, v2.2s|uabal2 v0.2d, v1.4s, v2.4s|sabdl v0.2d, v1.2s, v2.2s|sabdl2 v0.2d, v1.4s, v2.4s|uabdl v0.2d, v1.2s, v2.2s|smull v0.2d, v1.2s, v2.2s|smull2 v0.2d, v1.4s, v2.4s
smlal v0.2d, v1.2s, v2.2s|umlal v0.2d, v1.2s, v2.2s|umlal2 v0.2d, v1.4s, v2.4s|smlsl v0.2d, v1.2s, v2.2s|smlsl2 v0.2d, v1.4s, v2.4s|umlsl2 v0.2d, v1.4s, v2.4s|saddw v0.2d, v1.2d, v2.2s
saddw2 v0.2d, v1.2d, v2.4s|uaddw v0.2d, v1.2d, v2.2s|ssubw v0.2d, v1.2d, v2.2s|ssubw2 v0.2d, v1.2d, v2.4s|usubw v0.2d, v1.2d, v2.2s|usubw2 v0.2d, v1.2d, v2.4s|addhn v0.2s, v1.2d, v2.2d
addhn2 v0.4s, v1.2d, v2.2d|raddhn v0.2s, v1.2d, v2.2d|raddhn2 v0.4s, v1.2d, v2.2d|subhn2 v0.4s, v1.2d, v2.2d|rsubhn v0.2s, v1.2d, v2.2d|rsubhn2 v0.4s, v1.2d, v2.2d|pmull2 v0.8h, v1.16b, v2.16b
addv b0, v1.8b|smaxv b0, v1.8b|sminv b0, v1.8b|uminv b0, v1.8b|umaxv b0, v1.16b|uminv b0, v1.16b|smaxv h0, v1.4h|umaxv h0, v1.4h|uminv h0, v1.4h|smaxv h0, v1.8h|sminv h0, v1.8h|uminv h0, v1.8h
sminv s0, v1.4s|umaxv s0, v1.4s|uaddlv h0, v1.8b|saddlv h0, v1.16b|saddlv s0, v1.4h|uaddlv s0, v1.4h|saddlv s0, v1.8h|uaddlv d0, v1.4s|mul v0.4h, v1.4h, v2.h[0]|mla v0.4h, v1.4h, v2.h[0]
mls v0.4h, v1.4h, v2.h[0]|sqdmulh v0.4h, v1.4h, v2.h[0]|sqrdmulh v0.4h, v1.4h, v2.h[0]|mul v0.8h, v1.8h, v2.h[7]|mla v0.8h, v1.8h, v2.h[7]|mls v0.8h, v1.8h, v2.h[7]|sqdmulh v0.8h, v1.8h, v2.h[7]
sqrdmulh v0.8h, v1.8h, v2.h[7]|mul v0.2s, v1.2s, v2.s[1]|mla v0.2s, v1.2s, v2.s[1]|mls v0.2s, v1.2s, v2.s[1]|sqdmulh v0.2s, v1.2s, v2.s[1]|sqrdmulh v0.2s, v1.2s, v2.s[1]|mul v0.4s, v1.4s, v2.s[3]
mla v0.4s, v1.4s, v2.s[3]|mls v0.4s, v1.4s, v2.s[3]|sqdmulh v0.4s, v1.4s, v2.s[3]|sqrdmulh v0.4s, v1.4s, v2.s[3]|smull v0.4s, v1.4h, v2.h[5]|smull2 v0.4s, v1.8h, v2.h[5]|umull v0.4s, v1.4h, v2.h[5]
umull2 v0.4s, v1.8h, v2.h[5]|smlal v0.4s, v1.4h, v2.h[5]|smlal2 v0.4s, v1.8h, v2.h[5]|umlal v0.4s, v1.4h, v2.h[5]|umlal2 v0.4s, v1.8h, v2.h[5]|smlsl v0.4s, v1.4h, v2.h[5]|smlsl2 v0.4s, v1.8h, v2.h[5]
umlsl v0.4s, v1.4h, v2.h[5]|umlsl2 v0.4s, v1.8h, v2.h[5]|smull v0.2d, v1.2s, v2.s[2]|smull2 v0.2d, v1.4s, v2.s[2]|umull v0.2d, v1.2s, v2.s[2]|umull2 v0.2d, v1.4s, v2.s[2]|smlal v0.2d, v1.2s, v2.s[2]
smlal2 v0.2d, v1.4s, v2.s[2]|umlal v0.2d, v1.2s, v2.s[2]|umlal2 v0.2d, v1.4s, v2.s[2]|smlsl v0.2d, v1.2s, v2.s[2]|smlsl2 v0.2d, v1.4s, v2.s[2]|umlsl v0.2d, v1.2s, v2.s[2]|umlsl2 v0.2d, v1.4s, v2.s[2]
fmul v0.2s, v1.2s, v2.s[1]|fmla v0.2s, v1.2s, v2.s[1]|fmls v0.2s, v1.2s, v2.s[1]|fmulx v0.2s, v1.2s, v2.s[1]|fmla v0.4s, v1.4s, v2.s[3]|fmls v0.4s, v1.4s, v2.s[3]|fmulx v0.4s, v1.4s, v2.s[3]
fmla v0.2d, v1.2d, v2.d[1]|fmls v0.2d, v1.2d, v2.d[1]|fmulx v0.2d, v1.2d, v2.d[1]|fmla s0, s1, v2.s[2]|fmls s0, s1, v2.s[2]|fmulx s0, s1, v2.s[2]|fmul d0, d1, v2.d[1]|fmls d0, d1, v2.d[1]
fmulx d0, d1, v2.d[1]|zip1 v0.8b, v1.8b, v2.8b|zip2 v0.8b, v1.8b, v2.8b|uzp1 v0.8b, v1.8b, v2.8b|uzp2 v0.8b, v1.8b, v2.8b|trn1 v0.8b, v1.8b, v2.8b|zip1 v0.16b, v1.16b, v2.16b
uzp2 v0.16b, v1.16b, v2.16b|trn1 v0.16b, v1.16b, v2.16b|trn2 v0.16b, v1.16b, v2.16b|zip1 v0.4h, v1.4h, v2.4h|zip2 v0.4h, v1.4h, v2.4h|uzp1 v0.4h, v1.4h, v2.4h|uzp2 v0.4h, v1.4h, v2.4h
trn1 v0.4h, v1.4h, v2.4h|trn2 v0.4h, v1.4h, v2.4h|zip1 v0.8h, v1.8h, v2.8h|uzp2 v0.8h, v1.8h, v2.8h|trn1 v0.8h, v1.8h, v2.8h|trn2 v0.8h, v1.8h, v2.8h|zip1 v0.2s, v1.2s, v2.2s|zip2 v0.2s, v1.2s, v2.2s
uzp1 v0.2s, v1.2s, v2.2s|uzp2 v0.2s, v1.2s, v2.2s|trn2 v0.2s, v1.2s, v2.2s|zip2 v0.4s, v1.4s, v2.4s|uzp1 v0.4s, v1.4s, v2.4s|uzp2 v0.4s, v1.4s, v2.4s|trn2 v0.4s, v1.4s, v2.4s|zip2 v0.2d, v1.2d, v2.2d
uzp1 v0.2d, v1.2d, v2.2d|trn1 v0.2d, v1.2d, v2.2d|trn2 v0.2d, v1.2d, v2.2d|tbl v0.8b, {v1.16b}, v2.8b|tbx v0.8b, {v1.16b}, v2.8b|tbl v0.16b, {v1.16b, v2.16b}, v3.16b
tbx v0.16b, {v1.16b, v2.16b}, v3.16b|tbl v0.8b, {v1.16b, v2.16b, v3.16b}, v0.8b|tbx v0.8b, {v1.16b, v2.16b, v3.16b}, v0.8b|tbx v0.16b, {v1.16b, v2.16b, v3.16b}, v0.16b|ext v0.16b, v1.16b, v2.16b, #0
ext v0.16b, v1.16b, v2.16b, #1|ext v0.16b, v1.16b, v2.16b, #8|ext v0.16b, v1.16b, v2.16b, #15|ext v0.8b, v1.8b, v2.8b, #0|ext v0.8b, v1.8b, v2.8b, #3|ext v0.8b, v1.8b, v2.8b, #7|dup v0.8b, v1.b[15]
dup v0.16b, v1.b[0]|dup v0.4h, v1.h[7]|dup v0.8h, v1.h[0]|dup v0.2s, v1.s[3]|dup v0.4s, v1.s[1]|dup v0.2d, v1.d[0]|dup v0.8b, w2|dup v0.4h, w2|dup v0.8h, w2|dup v0.2s, w2|umov w2, v1.s[3]
smov w2, v1.h[7]|smov x2, v1.h[0]|smov x2, v1.s[3]|ins v0.s[0], w2|ins v0.h[7], w2|ins v0.b[15], v1.b[0]|mov v0.16b, v1.16b|mov v0.8b, v1.8b|movi v0.2s, #0xff, lsl #24|mvni v0.2s, #0xff, lsl #24
movi v0.4h, #0xa5, lsl #8|mvni v0.4h, #0xa5, lsl #8|movi v0.8h, #0x3c|mvni v0.8h, #0x3c|movi v0.2s, #0x12, msl #8|mvni v0.2s, #0x12, msl #8|movi v0.4s, #0x7f, msl #16|mvni v0.4s, #0x7f, msl #16
orr v0.8h, #0x81, lsl #8|bic v0.4h, #0x0f|orr v0.2s, #0xf0, lsl #16|bic v0.2s, #0x55, lsl #24|movi v0.2d, #0|movi v0.2d, #0xffffffffffffffff|sdot v0.2s, v1.8b, v2.8b|udot v0.4s, v1.16b, v2.16b
sdot v0.2s, v1.8b, v2.4b[0]|udot v0.4s, v1.16b, v2.4b[2]|sqadd b0, b1, b2|uqadd b0, b1, b2|sqsub b0, b1, b2|sqshl b0, b1, b2|uqshl b0, b1, b2|sqrshl b0, b1, b2|uqrshl b0, b1, b2|sqabs b0, b1
sqneg b0, b1|sqshl b0, b1, #0|uqshl b0, b1, #0|sqshlu b0, b1, #0|sqshl b0, b1, #4|uqshl b0, b1, #4|sqshlu b0, b1, #4|sqshl b0, b1, #7|uqshl b0, b1, #7|sqshlu b0, b1, #7|sqadd h0, h1, h2
sqsub h0, h1, h2|uqsub h0, h1, h2|sqshl h0, h1, h2|uqshl h0, h1, h2|sqrshl h0, h1, h2|uqrshl h0, h1, h2|sqabs h0, h1|sqshl h0, h1, #0|uqshl h0, h1, #0|sqshlu h0, h1, #0|sqshl h0, h1, #8
uqshl h0, h1, #8|sqshlu h0, h1, #8|sqshl h0, h1, #15|uqshl h0, h1, #15|sqshlu h0, h1, #15|uqadd s0, s1, s2|sqsub s0, s1, s2|uqsub s0, s1, s2|sqshl s0, s1, s2|uqshl s0, s1, s2|sqrshl s0, s1, s2
uqrshl s0, s1, s2|sqneg s0, s1|sqshl s0, s1, #0|uqshl s0, s1, #0|sqshlu s0, s1, #0|sqshl s0, s1, #16|uqshl s0, s1, #16|sqshlu s0, s1, #16|sqshl s0, s1, #31|uqshl s0, s1, #31|sqshlu s0, s1, #31
uqadd d0, d1, d2|uqsub d0, d1, d2|sqshl d0, d1, d2|uqshl d0, d1, d2|sqrshl d0, d1, d2|uqrshl d0, d1, d2|sqneg d0, d1|sqshl d0, d1, #0|uqshl d0, d1, #0|sqshlu d0, d1, #0|sqshl d0, d1, #32
uqshl d0, d1, #32|sqshlu d0, d1, #32|sqshl d0, d1, #63|uqshl d0, d1, #63|sqshlu d0, d1, #63|srshl d0, d1, d2|urshl d0, d1, d2|sshr d0, d1, #1|ssra d0, d1, #1|usra d0, d1, #1|srshr d0, d1, #1
urshr d0, d1, #1|srsra d0, d1, #1|ursra d0, d1, #1|sri d0, d1, #1|sshr d0, d1, #32|ushr d0, d1, #32|ssra d0, d1, #32|usra d0, d1, #32|srshr d0, d1, #32|urshr d0, d1, #32|srsra d0, d1, #32
ursra d0, d1, #32|sri d0, d1, #32|sshr d0, d1, #63|ushr d0, d1, #63|ssra d0, d1, #63|usra d0, d1, #63|srshr d0, d1, #63|urshr d0, d1, #63|srsra d0, d1, #63|ursra d0, d1, #63|sri d0, d1, #63
sshr d0, d1, #64|ushr d0, d1, #64|ssra d0, d1, #64|usra d0, d1, #64|srshr d0, d1, #64|urshr d0, d1, #64|srsra d0, d1, #64|ursra d0, d1, #64|sri d0, d1, #64|shl d0, d1, #0|sli d0, d1, #0
shl d0, d1, #31|sli d0, d1, #31|shl d0, d1, #63|sli d0, d1, #63|sqxtn b0, h1|uqxtn b0, h1|sqshrn b0, h1, #1|uqshrn b0, h1, #1|sqrshrn b0, h1, #1|uqrshrn b0, h1, #1|sqshrun b0, h1, #1
sqrshrun b0, h1, #1|sqshrn b0, h1, #8|uqshrn b0, h1, #8|sqrshrn b0, h1, #8|uqrshrn b0, h1, #8|sqshrun b0, h1, #8|sqrshrun b0, h1, #8|sqxtn h0, s1|sqxtun h0, s1|sqshrn h0, s1, #1|uqshrn h0, s1, #1
sqrshrn h0, s1, #1|uqrshrn h0, s1, #1|sqshrun h0, s1, #1|sqrshrun h0, s1, #1|sqshrn h0, s1, #16|uqshrn h0, s1, #16|sqrshrn h0, s1, #16|uqrshrn h0, s1, #16|sqshrun h0, s1, #16|sqrshrun h0, s1, #16
uqxtn s0, d1|sqxtun s0, d1|sqshrn s0, d1, #1|uqshrn s0, d1, #1|sqrshrn s0, d1, #1|uqrshrn s0, d1, #1|sqshrun s0, d1, #1|sqrshrun s0, d1, #1|sqshrn s0, d1, #32|uqshrn s0, d1, #32|sqrshrn s0, d1, #32
uqrshrn s0, d1, #32|sqshrun s0, d1, #32|sqrshrun s0, d1, #32|sqdmulh h0, h1, h2|sqrdmulh s0, s1, s2|fcmgt s0, s1, s2|facge s0, s1, s2|frsqrts s0, s1, s2|fminnm s0, s1, s2|fmin s0, s1, s2|fcvtnu s0, s1
fcvtps s0, s1|fcvtms s0, s1|fcvtmu s0, s1|fcvtzu s0, s1|fcvtas s0, s1|fcvtau s0, s1|fcmle s0, s1, #0.0|fcmlt s0, s1, #0.0|fcvtnu w2, s1|fcvtpu w2, s1|fcvtmu w2, s1|fcvtau w2, s1|fcvtns x2, s1
fcvtps x2, s1|fcvtpu x2, s1|fcvtms x2, s1|fcvtmu x2, s1|fcvtzu x2, s1|fcvtas x2, s1|fcvtau x2, s1|fmsub s0, s1, s2, s3|fnmsub s0, s1, s2, s3|fccmpe s0, s1, #3, eq|fcsel s0, s1, s2, eq
fccmpe s0, s1, #3, vs|fcsel s0, s1, s2, vs|fccmpe s0, s1, #3, hi|fcsel s0, s1, s2, hi|fccmpe s0, s1, #3, le|fcsel s0, s1, s2, le|fcmpe s0, #0.0|fcmeq d0, d1, d2|fcmge d0, d1, d2|facgt d0, d1, d2
frecps d0, d1, d2|fmaxnm d0, d1, d2|fmax d0, d1, d2|fnmul d0, d1, d2|fcvtns d0, d1|fcvtnu d0, d1|fcvtps d0, d1|fcvtpu d0, d1|fcvtmu d0, d1|fcvtzs d0, d1|fcvtau d0, d1|fcmeq d0, d1, #0.0
fcmge d0, d1, #0.0|fcmgt d0, d1, #0.0|fcvtns w2, d1|fcvtps w2, d1|fcvtpu w2, d1|fcvtms w2, d1|fcvtmu w2, d1|fcvtzu w2, d1|fcvtas w2, d1|fcvtau w2, d1|fcvtns x2, d1|fcvtnu x2, d1|fcvtpu x2, d1
fcvtmu x2, d1|fcvtas x2, d1|fmadd d0, d1, d2, d3|fnmadd d0, d1, d2, d3|fccmpe d0, d1, #3, eq|fcsel d0, d1, d2, eq|fccmpe d0, d1, #3, vs|fcsel d0, d1, d2, vs|fccmpe d0, d1, #3, hi|fcsel d0, d1, d2, hi
fccmpe d0, d1, #3, le|fcsel d0, d1, d2, le|fcmpe d0, #0.0|fmaxp d0, v1.2d|fminp s0, v1.2s|fmaxnmp d0, v1.2d|fminnmp s0, v1.2s|fcvtzs w2, d1, #31|fcvtzu w2, s1, #32|fcvtzs x2, d1, #64|ucvtf s0, x2, #64
scvtf d0, w2, #32|crc32b w2, w3, w4|crc32h w2, w3, w4|crc32w w2, w3, w4|crc32cb w2, w3, w4|crc32ch w2, w3, w4|crc32cw w2, w3, w4|crc32x w2, w3, x4|crc32cx w2, w3, x4
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
