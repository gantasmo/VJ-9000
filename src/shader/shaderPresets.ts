/**
 * Shader preset library for the generic GLSL shader VJ source.
 *
 * Each preset is a full GLSL ES 3.00 fragment shader on the atzedent uniform
 * convention (time / resolution / wheel / move / zoom / startRandom) plus the
 * audio uniforms ShaderRenderer exposes (u_bass / u_mid / u_high / u_volume,
 * 0..1, envelope-smoothed by the renderer) and two appearance uniforms every
 * shader honours: u_hue (0..1 hue rotation, an editable + audio-mappable param)
 * and u_material (a global shading style for the raymarched fractals).
 *
 * EDITABLE PARAMS: a preset's `params` are named float uniforms the UI exposes as
 * sliders, each optionally driven by an audio band. The renderer eases each toward
 * clamp(base + (max-min)*audioAmt*level, min, max) every frame, so slider drags,
 * preset switches and audio all morph smoothly. Every preset gets a Hue param.
 *
 * Library: yotta (Menger flythrough) + four distance-field fractals (Mandelbulb,
 * Julia, Mandelbox, kaleidoscopic IFS), all on the shared raymarch() template so
 * a fractal is a distance function + a colour. (Screen-space scenes were pulled;
 * better ones to be dropped in later.)
 */

export type ShaderAudioBand = 'none' | 'bass' | 'mid' | 'high' | 'volume';

export interface ShaderParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  audio?: ShaderAudioBand;
  /** Audio depth as a fraction of (max-min). Default 0.3. */
  audioAmt?: number;
}

export interface ShaderPreset {
  id: string;
  name: string;
  source: string;
  attribution: string;
  params?: ShaderParam[];
}

/** A param resolved against the live state, handed to the renderer per frame. */
export interface ShaderParamConfig {
  id: string;
  base: number;
  min: number;
  max: number;
  audio: ShaderAudioBand;
  amt: number;
}

/** Global shading styles (u_material) for the raymarched fractals. */
export const SHADER_MATERIALS = [
  'Neon',
  'Chrome',
  'Matte',
  'Glass',
  'Gold',
  'Iridescent',
  'Velvet',
  'Plasma',
] as const;

/** Every preset gets a Hue param (audio-mappable colour shift). */
const HUE_PARAM: ShaderParam = { id: 'u_hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0, audio: 'none' };

/** Rodrigues hue rotation in RGB; shared GLSL snippet declared in every shader. */
const HUE_GLSL =
  'vec3 hueShift(vec3 c, float h){ const vec3 k=vec3(0.57735); float ca=cos(h*6.2831853), sa=sin(h*6.2831853); return c*ca+cross(k,c)*sa+k*dot(k,c)*(1.0-ca); }';

/* ------------------------------------------------------------------ */
/* yotta -- recursive Menger "cloud computing" raymarcher with a Catmull-Rom
   spline flythrough. Source: Matthias Hurrle (@atzedent), MIT. Near-verbatim;
   the live editor + pointer steering are dropped and three editable uniforms
   were added (u_speed scales the flythrough, u_warmth tints, u_hue rotates the
   final colour) -- u_speed=1/u_warmth=1/u_hue=0 reproduce the original look. */
const YOTTA_SOURCE = `#version 300 es
/*********
* made by Matthias Hurrle (@atzedent)
*/
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform vec2 wheel;
uniform float u_speed;
uniform float u_warmth;
uniform float u_hue;
#define FC gl_FragCoord.xy
#define R resolution
#define T (time+wheel.y/1e3)
#define N normalize
#define S smoothstep
#define MN min(R.x,R.y)
#define LP vec3(-2,8,-2)
#define EDGESIZE 42e-4
#define hue(a) (.5+.5*sin(3.14*(a)+vec3(1,2,3)))
${HUE_GLSL}
vec3 cp[14];
void initCam() {
	const float a=2.*.96, b=2.*a;
	cp[0] =vec3(0);
	cp[1] =vec3(0,0,b);
	cp[2] =vec3(a,0,b);
	cp[3] =vec3(a,0,a);
	cp[4] =vec3(a,-a*1.2,a);
	cp[5] =vec3(-a,-a,a);
	cp[6] =vec3(-a,0,a);
	cp[7] =vec3(-a,0,0);
	cp[8] =vec3(0);
	cp[9] =vec3(0,0,-b);
	cp[10]=vec3(0,a,-b);
	cp[11]=vec3(-a,a,-b);
	cp[12]=vec3(-a,0,-b);
	cp[13]=vec3(-a,0,0);
}
vec3 catmull(vec3 a, vec3 b, vec3 c, vec3 d, float t){
	return (((-a+b*3.-c*3.+d)*t*t*t + (a*2.- b*5.+c*4.-d)*t*t + (-a+c)*t + b*2.)*.5);
}
vec3 camPath(float t){
	const int n=14;
	const float k=float(n);
	t=fract(t/k)*k;
	float sn=floor(t), st=t-sn;
	if (sn==.0) return catmull(cp[n-1], cp[0], cp[1], cp[2], st);
	for (int i=1; i<n-2; i++) {
		if (sn==float(i)) return catmull(cp[i-1], cp[i], cp[i+1], cp[i+2], st);
	}
	if (sn==k-2.) return catmull(cp[n-3], cp[n-2], cp[n-1], cp[0], st);
	if (sn==k-1.) return catmull(cp[n-2], cp[n-1], cp[0], cp[1], st);
	return vec3(0);
}
float rnd(vec3 p) {
	p=fract(p*vec3(12.9898,78.233,156.345));
	p+=dot(p,p+34.56);
	return fract(p.x*p.y*p.z);
}
float smin(float a, float b, float k) {
	k*=log(2.);
	float x=b-a;
	return a+x/(1.-exp2(x/k));
}
float box(vec3 p, float s) {
	p=abs(p)-s;
	return length(max(p,.0))+min(.0,max(max(p.x,p.y),p.z));
}
#define ZERO (time*.0)
float map(vec3 p) {
	float e=length(vec2(fract(p.z)-.5,p.y-1.))-.1;
	p.xz=mod(p.xz+1.,2.)-1.;
	float d=box(p,1.), f=1.;
	for(float i=ZERO; i<5.; i++) {
		vec3 a=mod(p*f,2.)-1., r=abs(1.-3.*abs(a));
		f*=2.25;
		float
		da=max(r.x,r.y),
		db=max(r.y,r.z),
		dc=max(r.z,r.x);
		d=max(d,(min(da,min(db,dc))-1.)/f);
	}
	return smin(d,e,1e-2)+2e-3;
}
vec3 norm(vec3 p) {
	float h=1e-3; vec2 k=vec2(-1,1);
	return N(
		k.xyy*map(p+k.xyy*h)+
		k.yxy*map(p+k.yxy*h)+
		k.yyx*map(p+k.yyx*h)+
		k.xxx*map(p+k.xxx*h)
	);
}
bool march(inout vec3 p, vec3 rd, out float dd, out float edge, out float i) {
	bool near;
	float maxd=abs(p.y)>1.?130.:800.;
	for (; i++<maxd;) {
		float d=map(p);
		if (abs(d)<1e-3) return true;
		if (d>100.) return false;
		if (near && d>EDGESIZE) edge=1.;
		if (d<EDGESIZE) near=true;
		p+=rd*d*.5;
		dd*=d*.5;
	}
}
float calcAO(vec3 p, vec3 n) {
	float occ=.0, sca=1.;
	for (float i=.0; i<5.; i++) {
		float
		h=.01+i*.05,
		d=map(p+h*n);
		occ+=(h-d)*sca;
		sca*=.95;
		if (occ>.35) break;
	}
	return clamp(1.-3.*occ,.0,1.);
}
float getao(vec3 p, vec3 n, float dist) {
	return clamp(map(p+n*dist)/dist,.0,1.);
}
vec3 dir(vec2 uv, vec3 ro, vec3 t, float z) {
	vec3 up=vec3(0,1,0),
	f=N(t-ro),
	r=N(cross(up,f)),
	u=cross(f,r),
	c=f*z,
	i=c+uv.x*r+uv.y*u,
	d=N(i);
	return d;
}
vec3 render(vec2 uv) {
	initCam();
	float speed=T*.25*u_speed;
	vec3 col=vec3(0),
	p=camPath(-speed+.5), ro=p,
	ta=camPath(-speed),
	rd=dir(uv,p,ta,.6);
	float dd, i, edge;
	if (march(p,rd,dd,edge,i)) {
		float x=mix(.8,1.,rnd(p)), lf=S(80.,30.,length(p.z));
		vec3 n=norm(p)*x, lp=vec3(LP.x,LP.y+lf,LP.z), l=N(lp-p);
		float ao=calcAO(p,n), amb=.8+.2*n.y, ld=distance(lp,p),
		ldd=distance(ro,p), dif=clamp(dot(l,n),.0,1.),
		atten=1./(1.+ldd*.5+ldd*ldd*.25);
		if (abs(p.y)<.992) {
			ao*=(n.y*.5+.55);
			col+=S(-.1,1.,amb*ao)+dif*ao*atten;
			col+=atten*pow(clamp(dot(N(ro-p),n),.0,1.),.8);
		} else col+=dif*ao;
		col+=clamp(dot(-rd,l),.0,1.)*ao*atten;
		col*=vec3(1,.65,.5)+.3*amb*ao*atten;
		col*=tanh(ao*ao);
		float fog=1.-clamp(dd/200.,.0,1.), eo=getao(p,n,EDGESIZE);;
		if(eo<.9) edge=max(edge,max(1.,fog));
		eo=getao(p,n,-EDGESIZE);
		if(eo<.9) edge=max(edge,max(1.,fog));
		float fres=pow(clamp(1.+dot(rd,n),.0,1.),5.);
		col*=S(2.,.0,edge)*(1.-fres);
		vec3 dp=abs(p-ro);
    float ll=.3/tan(length(dp))+T;
		dp=(.5+.5*cos(.78*T-vec3(0,-2,3)*fract(ll)-.5));
		dp=p.y>1.01?vec3(1):.02/dp.bgg;
		col=mix(col,fres*dp,S(.5,3.,edge));
		col=S(-.5,2.,col);
	}
	float k=max(.3,1.-distance(LP,ro));
	col+=hue(k*k*1.57+1.5)*k*.6;
	col=mix(col,vec3(1,.95,.9),S(.0,15.,distance(p,ro)));
	col+=S(-1.,2.,clamp(i/300.,.0,1.))*k*vec3(1,.65,.5);
	col=S(-.2,.8,col*1.2);
	col=tanh(col*col*col);
	col=sqrt(col);
	vec2 c=FC/R;
	c*=1.-c.yx;
	float vig=c.x*c.y*25.;
	vig=pow(vig,.25);
	col*=vig;
	col=mix(col,col*col,S(1.,-1.,clamp(vig,.0,1.)));
	return col*mix(vec3(.95,.97,1.),vec3(1,.85,.65),u_warmth);
}
void main() {
	vec2 uv=(FC-.5*R)/MN;
	vec3 col=render(uv);
	col=hueShift(col,u_hue);
	O=vec4(col,1);
}`;

/* ------------------------------------------------------------------ */
/* Shared distance-field raymarch harness. A fractal supplies its distance
   estimator + colour + uniforms; the camera, march, normal, material shading,
   glow, hue, tone-map and vignette live here so a new fractal is a few lines on
   one tested base. u_material picks one of eight shading styles (see
   SHADER_MATERIALS), each with its own surface look so the fractals are not all
   the same neon gradient. Distance estimators are textbook public-domain. */
function raymarch(opts: {
  uniforms: string;
  helpers?: string;
  de: string;
  color: string;
  camDist: number;
  glow: string;
  iters?: number;
  maxd?: number;
}): string {
  return `#version 300 es
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform vec2 wheel;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_volume;
uniform float u_hue;
uniform float u_material;
${opts.uniforms}
#define T (time + wheel.y/1e3)
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
${HUE_GLSL}
vec3 env(vec3 d){ float t=d.y*0.5+0.5; vec3 c=mix(vec3(0.03,0.04,0.07),vec3(0.45,0.55,0.75),t); c+=vec3(1.0,0.95,0.85)*pow(max(dot(d,normalize(vec3(0.6,0.7,0.4))),0.0),24.0)*2.0; c+=vec3(0.4,0.5,0.7)*pow(max(dot(d,normalize(vec3(-0.5,0.2,-0.6))),0.0),8.0); return c; }
${opts.helpers ?? ''}
float de(vec3 p){
${opts.de}
}
vec3 nrm(vec3 p){
  vec2 e=vec2(1e-3,0.);
  return normalize(vec3(
    de(p+e.xyy)-de(p-e.xyy),
    de(p+e.yxy)-de(p-e.yxy),
    de(p+e.yyx)-de(p-e.yyx)));
}
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*resolution)/min(resolution.x,resolution.y);
  vec3 ro=vec3(0.,0.,${opts.camDist.toFixed(2)});
  vec3 rd=normalize(vec3(uv,-1.3));
  float a=T*0.2;
  ro.xz*=rot(a); rd.xz*=rot(a);
  float b=sin(T*0.15)*0.4;
  ro.yz*=rot(b); rd.yz*=rot(b);
  float t=0., g=0.;
  vec3 p=ro;
  bool hit=false;
  for(int i=0;i<${opts.iters ?? 140};i++){
    p=ro+rd*t;
    float d=de(p);
    g+=0.015/(1.0+d*d*30.0);
    if(d<1e-3){ hit=true; break; }
    if(t>${(opts.maxd ?? 14).toFixed(1)}) break;
    t+=d*0.6;
  }
  vec3 col=vec3(0.);
  if(hit){
    vec3 n=nrm(p);
    vec3 l=normalize(vec3(0.7,0.8,0.6));
    float dif=clamp(dot(n,l),0.,1.);
    float fres=pow(1.0-clamp(dot(n,-rd),0.,1.),3.0);
    vec3 base=${opts.color};
    vec3 rf=reflect(rd,n);
    int mat=int(u_material+0.5);
    if(mat==1){ // Chrome -- mirror reflection of the environment
      col=env(rf)*(0.85+0.15*fres)+vec3(pow(max(dot(rf,l),0.),80.0));
    } else if(mat==2){ // Matte -- flat clay, solid albedo, no rainbow
      col=vec3(0.78,0.75,0.72)*(0.12+0.88*dif)+env(n)*0.08;
    } else if(mat==3){ // Glass -- refraction + fresnel reflection + sharp spec
      vec3 rr=refract(rd,n,0.72);
      col=mix(vec3(0.55,0.8,1.0)*env(rr)*1.1, env(rf), clamp(fres+0.1,0.,1.))+vec3(pow(max(dot(rf,l),0.),120.0));
    } else if(mat==4){ // Gold -- gold-tinted metal reflection
      vec3 gd=vec3(1.0,0.76,0.33);
      col=env(rf)*gd+gd*0.08+vec3(1.0,0.9,0.6)*pow(max(dot(rf,l),0.),60.0);
    } else if(mat==5){ // Iridescent -- thin-film shimmer over a reflective base
      vec3 ir=0.5+0.5*cos(6.2831*(fres*3.0+vec3(0.0,0.33,0.67)));
      col=env(rf)*0.25+ir*(0.4+0.5*dif)+ir*fres*1.2;
    } else if(mat==6){ // Velvet -- deep fabric with a retroreflective rim
      float rim=pow(1.0-max(dot(n,-rd),0.),1.5);
      col=vec3(0.45,0.08,0.55)*(0.08+0.4*dif)+vec3(0.45,0.08,0.55)*rim*1.8;
    } else if(mat==7){ // Plasma -- energy field (position palette is the point)
      col=base*0.5+base*pow(fres,1.5)*3.0+base*dif*0.5;
    } else { // Neon -- glowing emissive tube
      vec3 neon=mix(vec3(1.0,0.1,0.6), vec3(0.1,0.85,1.0), 0.5+0.5*n.y);
      col=neon*(0.5+0.4*dif)+neon*fres*2.2;
    }
  }
  col+=g*(${opts.glow})*(0.5+0.5*cos(vec3(0,1,2)+T+u_high*4.0));
  col=pow(clamp(col,0.,1.),vec3(0.75));
  vec2 q=gl_FragCoord.xy/resolution;
  col*=0.4+0.6*pow(16.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.2);
  col=hueShift(col,u_hue);
  O=vec4(col,1.0);
}`;
}

const MANDELBULB = raymarch({
  uniforms: 'uniform float u_power;\nuniform float u_glow;',
  camDist: 2.6,
  maxd: 14,
  glow: 'u_glow',
  de: `  vec3 z=p; float dr=1.0, r=0.0;
  for(int i=0;i<8;i++){
    r=length(z); if(r>2.0) break;
    float th=acos(clamp(z.z/r,-1.,1.))*u_power;
    float ph=atan(z.y,z.x)*u_power;
    dr=pow(r,u_power-1.0)*u_power*dr+1.0;
    float zr=pow(r,u_power);
    z=zr*vec3(sin(th)*cos(ph),sin(th)*sin(ph),cos(th))+p;
  }
  return 0.5*log(max(r,1e-6))*r/dr;`,
  color: '(0.5+0.5*cos(vec3(0.,0.6,1.0)*6.0+length(p)*2.5+T*0.4))',
});

const JULIABULB = raymarch({
  uniforms: 'uniform float u_power;\nuniform float u_cx;\nuniform float u_cy;\nuniform float u_glow;',
  camDist: 2.4,
  maxd: 12,
  glow: 'u_glow',
  de: `  vec3 z=p; float dr=1.0, r=0.0;
  vec3 c=vec3(u_cx,u_cy,0.3*sin(T*0.1));
  for(int i=0;i<10;i++){
    r=length(z); if(r>2.0) break;
    float th=acos(clamp(z.z/r,-1.,1.))*u_power;
    float ph=atan(z.y,z.x)*u_power;
    dr=pow(r,u_power-1.0)*u_power*dr+1.0;
    float zr=pow(r,u_power);
    z=zr*vec3(sin(th)*cos(ph),sin(th)*sin(ph),cos(th))+c;
  }
  return 0.5*log(max(r,1e-6))*r/dr;`,
  color: '(0.5+0.5*cos(vec3(0.,0.5,1.0)*6.2+length(p)*3.0+u_mid*4.0+T*0.3))',
});

const MANDELBOX = raymarch({
  uniforms: 'uniform float u_scale;\nuniform float u_glow;',
  camDist: 7.0,
  maxd: 30,
  glow: 'u_glow',
  de: `  vec3 z=p; float dr=1.0;
  for(int i=0;i<12;i++){
    z=clamp(z,-1.0,1.0)*2.0-z;
    float r2=dot(z,z);
    if(r2<0.25){ z*=4.0; dr*=4.0; }
    else if(r2<1.0){ z/=r2; dr/=r2; }
    z=z*u_scale+p;
    dr=dr*abs(u_scale)+1.0;
  }
  return length(z)/abs(dr);`,
  color: '(0.5+0.5*cos(vec3(0.,0.7,1.0)*5.0+p.y*1.5+length(p)*1.2+T*0.25))',
});

const KIFS = raymarch({
  uniforms: 'uniform float u_kscale;\nuniform float u_kang;\nuniform float u_glow;',
  camDist: 3.0,
  maxd: 16,
  glow: 'u_glow',
  de: `  float s=1.0;
  for(int i=0;i<12;i++){
    p.xy*=rot(u_kang);
    if(p.x+p.y<0.0) p.xy=-p.yx;
    if(p.x+p.z<0.0) p.xz=-p.zx;
    if(p.y+p.z<0.0) p.yz=-p.zy;
    p=p*u_kscale-vec3(1.0)*(u_kscale-1.0);
    s*=u_kscale;
  }
  return length(p)/s-0.002;`,
  color: '(0.5+0.5*cos(vec3(0.,0.4,0.8)*7.0+length(p)*3.5+T*0.5))',
});

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: 'yotta',
    name: 'Yotta (Cloud Computing)',
    source: YOTTA_SOURCE,
    attribution: 'Matthias Hurrle (@atzedent), MIT (speed/warmth/hue added)',
    params: [
      { id: 'u_speed', label: 'Speed', min: 0, max: 4, step: 0.05, default: 1, audio: 'none' },
      { id: 'u_warmth', label: 'Warmth', min: 0, max: 1, step: 0.02, default: 1, audio: 'none' },
      HUE_PARAM,
    ],
  },
  {
    id: 'mandelbulb',
    name: 'Mandelbulb',
    source: MANDELBULB,
    attribution: 'GANTASMO (public-domain Mandelbulb DE)',
    params: [
      { id: 'u_power', label: 'Power', min: 2, max: 12, step: 0.1, default: 8, audio: 'bass', audioAmt: 0.22 },
      { id: 'u_glow', label: 'Glow', min: 0, max: 3, step: 0.05, default: 1, audio: 'none' },
      HUE_PARAM,
    ],
  },
  {
    id: 'juliabulb',
    name: 'Julia Bulb',
    source: JULIABULB,
    attribution: 'GANTASMO (public-domain Julia DE)',
    params: [
      { id: 'u_power', label: 'Power', min: 2, max: 10, step: 0.1, default: 8, audio: 'none' },
      { id: 'u_cx', label: 'Seed X', min: -1, max: 1, step: 0.01, default: 0.45, audio: 'mid', audioAmt: 0.15 },
      { id: 'u_cy', label: 'Seed Y', min: -1, max: 1, step: 0.01, default: 0.3, audio: 'high', audioAmt: 0.15 },
      { id: 'u_glow', label: 'Glow', min: 0, max: 3, step: 0.05, default: 1, audio: 'none' },
      HUE_PARAM,
    ],
  },
  {
    id: 'mandelbox',
    name: 'Mandelbox',
    source: MANDELBOX,
    attribution: 'GANTASMO (public-domain Mandelbox DE)',
    params: [
      { id: 'u_scale', label: 'Scale', min: -3, max: 3, step: 0.01, default: 2.1, audio: 'none' },
      { id: 'u_glow', label: 'Glow', min: 0, max: 3, step: 0.05, default: 1, audio: 'volume', audioAmt: 0.4 },
      HUE_PARAM,
    ],
  },
  {
    id: 'kifs',
    name: 'Kaleido IFS',
    source: KIFS,
    attribution: 'GANTASMO (public-domain kaleidoscopic IFS)',
    params: [
      { id: 'u_kscale', label: 'Scale', min: 1.5, max: 2.6, step: 0.01, default: 2.0, audio: 'none' },
      { id: 'u_kang', label: 'Twist', min: -1.5, max: 1.5, step: 0.01, default: 0.4, audio: 'mid', audioAmt: 0.4 },
      { id: 'u_glow', label: 'Glow', min: 0, max: 3, step: 0.05, default: 1, audio: 'none' },
      HUE_PARAM,
    ],
  },
];

/** Resolve a preset's declared params against the live state overrides into the
 *  flat config the renderer consumes each frame. */
export function resolveShaderParams(
  shaderId: string,
  valueOverrides: Record<string, number> | undefined,
  audioOverrides: Record<string, ShaderAudioBand> | undefined,
): ShaderParamConfig[] {
  const preset = SHADER_PRESETS.find((p) => p.id === shaderId) ?? SHADER_PRESETS[0];
  return (preset.params ?? []).map((p) => {
    const key = `${preset.id}:${p.id}`;
    return {
      id: p.id,
      base: valueOverrides?.[key] ?? p.default,
      min: p.min,
      max: p.max,
      audio: audioOverrides?.[key] ?? p.audio ?? 'none',
      amt: p.audioAmt ?? 0.3,
    };
  });
}
