import json, datetime as dt
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt, matplotlib.dates as md
D=json.load(open('series.json')); T0=dt.datetime(2026,11,12,23,54,37)
tm=lambda s: T0+dt.timedelta(seconds=s)
BLUE,ORANGE,INK,MUTED,GRID='#2a78d6','#eb6834','#0b0b0b','#52514e','#e4e3df'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':7,'axes.edgecolor':MUTED,'axes.labelcolor':MUTED,
  'xtick.color':MUTED,'ytick.color':MUTED,'axes.spines.top':False,'axes.spines.right':False})
fig,ax=plt.subplots(4,1,figsize=(6.5,3.45),sharex=True,gridspec_kw={'height_ratios':[0.8,1,1,1],'hspace':0.32})
# occupied shading from the timeline
tl=json.load(open('/mnt/user-data/attachments/d1326f0b-0e10-50d7-9d8e-6ba9f42f9807/47ad7d63-timeline.json'))
loc=lambda z: dt.datetime.fromisoformat(z.replace('Z','+00:00')).replace(tzinfo=None)+dt.timedelta(hours=1)
for o in tl['lanes']['occupied']:
    a,b=loc(o['start']),loc(o['end'])
    if b>T0: ax[0].axvspan(max(a,T0),min(b,tm(37077)),color='#ecebe7',lw=0,zorder=0)
p=D['presence']; pulses=[(p[i][0],p[i+1][0]-p[i][0]) for i in range(len(p)-1) if p[i][1]==1 and p[i+1][1]==0]
long=[tm(t) for t,d in pulses if d>=2]; short=[tm(t) for t,d in pulses if d<2]
ax[0].vlines(long,0.62,1.0,color=BLUE,lw=1.2); ax[0].vlines(short,0.0,0.38,color=ORANGE,lw=1.2)
ax[0].set_ylim(-0.05,1.05); ax[0].set_yticks([0.19,0.81]); ax[0].set_yticklabels([f'under 2 s ({len(short)})',f'2 s or more ({len(long)})'])
ax[0].set_title('Motion pulses from the PIR (grey: counted as occupied)',loc='left',fontsize=7.5,color=INK,pad=3)
def line(a,key,title,unit,color=BLUE):
    s=D[key]; a.step([tm(t) for t,_ in s],[v for _,v in s],where='post',color=color,lw=1.5)
    a.set_title(title,loc='left',fontsize=7.5,color=INK,pad=3); a.set_ylabel(unit); a.grid(axis='y',color=GRID,lw=0.6)
line(ax[1],'light','Light','lux'); line(ax[2],'temperature','Temperature','°C'); line(ax[3],'humidity','Relative humidity','%')
ax[1].annotate('room lamp on 00:19–01:47',xy=(tm(3000),88),xytext=(tm(9500),70),fontsize=6.5,color=MUTED,arrowprops=dict(arrowstyle='-',color=MUTED,lw=0.6))
ax[1].annotate('daylight from about 08:00',xy=(tm(30500),8),xytext=(tm(19000),40),fontsize=6.5,color=MUTED,arrowprops=dict(arrowstyle='-',color=MUTED,lw=0.6))
ax[3].annotate('+3 points in 5 min at 01:43',xy=(tm(6550),61.0),xytext=(tm(10500),60.6),fontsize=6.5,color=MUTED,arrowprops=dict(arrowstyle='-',color=MUTED,lw=0.6))
for a in ax:
    a.axvline(dt.datetime(2026,11,13,9,40),color=MUTED,lw=0.7,ls=(0,(2,2)))
ax[0].text(dt.datetime(2026,11,13,9,37),1.08,'no-show 09:40',ha='right',va='bottom',fontsize=6.5,color=MUTED,transform=ax[0].get_xaxis_transform())
ax[3].xaxis.set_major_locator(md.HourLocator(interval=1)); ax[3].xaxis.set_major_formatter(md.DateFormatter('%H:%M'))
ax[3].set_xlim(dt.datetime(2026,11,12,23,50),dt.datetime(2026,11,13,10,16))
fig.savefig('overnight.png',dpi=220,bbox_inches='tight',facecolor='white')
print(len(long),len(short))
