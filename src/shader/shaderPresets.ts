/**
 * Shader preset library for the generic GLSL shader VJ source.
 *
 * Each preset is a full GLSL ES 3.00 fragment shader written to the atzedent
 * uniform convention (the same one CodePen shadertoys by @atzedent share):
 *   uniform float time;        // seconds since enable
 *   uniform vec2  resolution;  // canvas size in px
 *   uniform vec2  wheel;       // x = last delta, y = accumulated scrub offset
 *   uniform vec2  move;        // pointer move (zeroed here; runs hands-off)
 *   uniform float zoom;        // pinch/scroll zoom (audio-driven here)
 *   uniform float startRandom; // per-instance random seed
 * ShaderRenderer also exposes audio uniforms a shader MAY declare to react
 * directly: uniform float u_bass, u_mid, u_high, u_volume; (all 0..1). A shader
 * that omits them still reacts, because the renderer accelerates the camera scrub
 * (wheel.y) with the audio energy, so an unmodified atzedent flythrough flies
 * faster on louder passages with no shader edit.
 *
 * yotta seeds the library; new shaders drop in as additional entries with no
 * renderer or wiring change.
 */
export interface ShaderPreset {
  id: string;
  name: string;
  /** Full GLSL ES 3.00 fragment source. */
  source: string;
  /** Author attribution + license, shown in the panel and kept in code. */
  attribution: string;
}

// yotta -- "cloud computing" recursive Menger-fractal raymarcher with a
// Catmull-Rom spline camera flythrough. Source: Matthias Hurrle (@atzedent),
// https://codepen.io/atzedent/pen/bNBRGbR, MIT. Ported verbatim; the live-code
// editor and pointer steering from the original harness are dropped.
const YOTTA_SOURCE = `#version 300 es
/*********
* made by Matthias Hurrle (@atzedent)
*/
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform vec2 wheel;
#define FC gl_FragCoord.xy
#define R resolution
#define T (time+wheel.y/1e3)
#define N normalize
#define S smoothstep
#define MN min(R.x,R.y)
#define LP vec3(-2,8,-2)
#define EDGESIZE 42e-4
#define hue(a) (.5+.5*sin(3.14*(a)+vec3(1,2,3)))
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
	float speed=T*.25;
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
	return col*vec3(1,.85,.65);
}
void main() {
	vec2 uv=(FC-.5*R)/MN;
	vec3 col=render(uv);
	O=vec4(col,1);
}`;

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: 'yotta',
    name: 'Yotta (Cloud Computing)',
    source: YOTTA_SOURCE,
    attribution: 'Matthias Hurrle (@atzedent), MIT',
  },
];
