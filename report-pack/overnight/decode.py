import json, datetime as dt
T0 = dt.datetime(2026,11,12,23,54,37)  # local Paris time of offset 0 (22:54:37Z)
SC = {'temperature':100,'humidity':10,'pressure':10,'gas':0.01,'light':10,'presence':1}
def dec(name):
    t=v=0; out=[]
    for tok in open(name+'.enc').read().split():
        a,b=tok.split('.'); t+=int(a,36); v+=int(b,36); out.append((t, v/SC[name]))
    return out
D={k:dec(k) for k in SC}
json.dump(D, open('series.json','w'))
if __name__=='__main__':
    for k,s in D.items():
        vs=[v for _,v in s]; print(k,len(s),min(vs),max(vs),round(sum(vs)/len(vs),2), 'last t',s[-1][0])
